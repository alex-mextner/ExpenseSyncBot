import { format, getDaysInMonth, startOfMonth, subDays, subMonths } from 'date-fns';
import type { CurrencyCode } from '../../config/constants';
import { database } from '../../database';
import { convertCurrency } from '../currency/converter';
import type {
  BudgetBurnRate,
  BudgetUtilization,
  CategoryAnomaly,
  CategoryChange,
  CategoryProjection,
  DayOfWeekPattern,
  FinancialSnapshot,
  MonthlyProjection,
  SpendingStreak,
  SpendingTrend,
  SpendingVelocity,
} from './types';

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/**
 * SpendingAnalytics - computes financial metrics from expense data
 * All methods are synchronous (bun:sqlite is synchronous)
 * Uses parameterized dates from JS, not SQLite date('now'), for timezone safety
 */
export class SpendingAnalytics {
  /**
   * Main entry point: compute full financial snapshot for a group
   */
  getFinancialSnapshot(groupId: number): FinancialSnapshot {
    const now = new Date();
    const today = format(now, 'yyyy-MM-dd');
    const currentMonthStr = format(now, 'yyyy-MM');
    const currentMonthStart = format(startOfMonth(now), 'yyyy-MM-dd');

    return {
      burnRates: this.computeBurnRates(groupId, now, currentMonthStr, currentMonthStart, today),
      weekTrend: this.computeWeekOverWeek(groupId, today),
      monthTrend: this.computeMonthOverMonth(groupId, now, currentMonthStart, today),
      anomalies: this.computeAnomalies(groupId, now, currentMonthStart, today),
      dayOfWeekPatterns: this.computeDayPatterns(groupId, today),
      velocity: this.computeVelocity(groupId, today),
      budgetUtilization: this.computeBudgetUtilization(
        groupId,
        currentMonthStr,
        currentMonthStart,
        today,
      ),
      streak: this.computeStreak(groupId, today),
      projection: this.computeProjection(groupId, now, currentMonthStr, currentMonthStart, today),
    };
  }

  /**
   * Budget burn rate per category
   * Thresholds cascade top-down: exceeded > critical > warning > on_track
   */
  private computeBurnRates(
    groupId: number,
    now: Date,
    currentMonth: string,
    monthStart: string,
    today: string,
  ): BudgetBurnRate[] {
    const budgets = database.budgets.getAllBudgetsForMonth(groupId, currentMonth);
    if (budgets.length === 0) return [];

    const categoryTotals = database.expenses.getCategoryTotals(groupId, monthStart, today);
    const categorySpentEur: Record<string, number> = {};
    for (const ct of categoryTotals) {
      categorySpentEur[ct.category] = ct.total;
    }

    const dayOfMonth = now.getDate();
    const daysInMonth = getDaysInMonth(now);
    const daysElapsed = dayOfMonth; // 1-indexed: day 1 = 1 day elapsed
    const daysRemaining = daysInMonth - daysElapsed;

    const results: BudgetBurnRate[] = [];

    for (const budget of budgets) {
      const currency = budget.currency as CurrencyCode;
      const spentEur = categorySpentEur[budget.category] || 0;
      // Convert EUR spent to budget currency for comparison
      const spent = convertCurrency(spentEur, 'EUR', currency);

      const dailyBurnRate = daysElapsed > 0 ? Math.round((spent / daysElapsed) * 100) / 100 : 0;
      const projectedTotal = dailyBurnRate * daysInMonth;
      const projectedOvershoot = projectedTotal - budget.limit_amount;
      const runwayDays =
        dailyBurnRate > 0 ? (budget.limit_amount - spent) / dailyBurnRate : Infinity;

      // Determine status: cascade top-down
      let status: BudgetBurnRate['status'];
      if (spent >= budget.limit_amount) {
        status = 'exceeded';
      } else if (projectedTotal > budget.limit_amount * 1.0) {
        status = 'critical';
      } else if (projectedTotal > budget.limit_amount * 0.85) {
        status = 'warning';
      } else {
        status = 'on_track';
      }

      results.push({
        category: budget.category,
        budget_limit: budget.limit_amount,
        spent,
        currency,
        days_elapsed: daysElapsed,
        days_remaining: daysRemaining,
        daily_burn_rate: Math.round(dailyBurnRate * 100) / 100,
        projected_total: Math.round(projectedTotal * 100) / 100,
        projected_overshoot: Math.round(projectedOvershoot * 100) / 100,
        runway_days: runwayDays === Infinity ? 999 : Math.round(runwayDays * 10) / 10,
        status,
      });
    }

    return results;
  }

  /**
   * Week-over-week comparison (last 7 days vs previous 7 days)
   */
  private computeWeekOverWeek(groupId: number, today: string): SpendingTrend {
    const rows = database.expenses.getWeekOverWeekData(groupId, today);

    const currentByCategory: Record<string, number> = {};
    const previousByCategory: Record<string, number> = {};
    let currentTotal = 0;
    let previousTotal = 0;

    for (const row of rows) {
      if (row.period === 'current_week') {
        currentByCategory[row.category] = (currentByCategory[row.category] || 0) + row.total;
        currentTotal += row.total;
      } else if (row.period === 'previous_week') {
        previousByCategory[row.category] = (previousByCategory[row.category] || 0) + row.total;
        previousTotal += row.total;
      }
    }

    const changePercent =
      previousTotal > 0
        ? ((currentTotal - previousTotal) / previousTotal) * 100
        : currentTotal > 0
          ? 100
          : 0;

    const allCategories = new Set([
      ...Object.keys(currentByCategory),
      ...Object.keys(previousByCategory),
    ]);
    const categoryChanges: CategoryChange[] = [];

    for (const category of allCategories) {
      const current = currentByCategory[category] || 0;
      const previous = previousByCategory[category] || 0;
      const catChange =
        previous > 0 ? ((current - previous) / previous) * 100 : current > 0 ? 100 : 0;
      categoryChanges.push({
        category,
        current: Math.round(current * 100) / 100,
        previous: Math.round(previous * 100) / 100,
        change_percent: Math.round(catChange * 10) / 10,
      });
    }

    // Sort by absolute change descending
    categoryChanges.sort((a, b) => Math.abs(b.change_percent) - Math.abs(a.change_percent));

    return {
      period: 'week',
      current_total: Math.round(currentTotal * 100) / 100,
      previous_total: Math.round(previousTotal * 100) / 100,
      change_percent: Math.round(changePercent * 10) / 10,
      direction: Math.abs(changePercent) <= 5 ? 'stable' : changePercent > 0 ? 'up' : 'down',
      category_changes: categoryChanges.slice(0, 10),
    };
  }

  /**
   * Month-over-month comparison (proportional: first N days of current month vs first N days of previous month)
   */
  private computeMonthOverMonth(
    groupId: number,
    now: Date,
    currentMonthStart: string,
    today: string,
  ): SpendingTrend {
    const dayOfMonth = now.getDate();
    const prevMonth = subMonths(now, 1);
    const prevMonthStart = format(startOfMonth(prevMonth), 'yyyy-MM-dd');
    // Same day in previous month for proportional comparison
    const prevMonthDaysInMonth = getDaysInMonth(prevMonth);
    const prevMonthDay = Math.min(dayOfMonth, prevMonthDaysInMonth);
    const prevMonthSameDay = `${format(prevMonth, 'yyyy-MM')}-${String(prevMonthDay).padStart(2, '0')}`;

    const rows = database.expenses.getMonthOverMonthData(
      groupId,
      currentMonthStart,
      today,
      prevMonthStart,
      prevMonthSameDay,
    );

    let currentTotal = 0;
    let previousTotal = 0;
    const categoryChanges: CategoryChange[] = [];

    for (const row of rows) {
      currentTotal += row.current_month;
      previousTotal += row.previous_month;

      const catChange =
        row.previous_month > 0
          ? ((row.current_month - row.previous_month) / row.previous_month) * 100
          : row.current_month > 0
            ? 100
            : 0;

      if (row.current_month > 0 || row.previous_month > 0) {
        categoryChanges.push({
          category: row.category,
          current: Math.round(row.current_month * 100) / 100,
          previous: Math.round(row.previous_month * 100) / 100,
          change_percent: Math.round(catChange * 10) / 10,
        });
      }
    }

    const changePercent =
      previousTotal > 0
        ? ((currentTotal - previousTotal) / previousTotal) * 100
        : currentTotal > 0
          ? 100
          : 0;

    categoryChanges.sort((a, b) => Math.abs(b.change_percent) - Math.abs(a.change_percent));

    return {
      period: 'month',
      current_total: Math.round(currentTotal * 100) / 100,
      previous_total: Math.round(previousTotal * 100) / 100,
      change_percent: Math.round(changePercent * 10) / 10,
      direction: Math.abs(changePercent) <= 5 ? 'stable' : changePercent > 0 ? 'up' : 'down',
      category_changes: categoryChanges.slice(0, 10),
    };
  }

  /**
   * Category anomaly detection: current month vs 3-month average
   * Deviation > 1.5x = anomaly
   */
  private computeAnomalies(
    groupId: number,
    now: Date,
    currentMonthStart: string,
    today: string,
  ): CategoryAnomaly[] {
    // Get current month category totals
    const currentTotals = database.expenses.getCategoryTotals(groupId, currentMonthStart, today);
    const currentMap: Record<string, number> = {};
    for (const ct of currentTotals) {
      currentMap[ct.category] = ct.total;
    }

    // Get 3 months of historical data (excluding current month)
    const threeMonthsAgo = subMonths(startOfMonth(now), 3);
    const historyStart = format(threeMonthsAgo, 'yyyy-MM-dd');

    const historyRows = database.expenses.getMonthlyHistoryByCategory(
      groupId,
      historyStart,
      currentMonthStart,
    );

    // Compute average per category over the history months
    const categoryHistory: Record<string, { total: number; months: number }> = {};
    for (const row of historyRows) {
      if (!categoryHistory[row.category]) {
        categoryHistory[row.category] = { total: 0, months: 0 };
      }
      const entry = categoryHistory[row.category]!;
      entry.total += row.monthly_total;
      entry.months += 1;
    }

    const anomalies: CategoryAnomaly[] = [];

    for (const [category, currentTotal] of Object.entries(currentMap)) {
      const history = categoryHistory[category];
      if (!history || history.months === 0) continue;

      const avg3Month = history.total / history.months;
      if (avg3Month <= 0) continue;

      const deviationRatio = currentTotal / avg3Month;

      if (deviationRatio >= 1.3) {
        let severity: CategoryAnomaly['severity'];
        if (deviationRatio >= 2.5) {
          severity = 'extreme';
        } else if (deviationRatio >= 1.5) {
          severity = 'significant';
        } else {
          severity = 'mild';
        }

        anomalies.push({
          category,
          current_month_total: Math.round(currentTotal * 100) / 100,
          avg_3_month: Math.round(avg3Month * 100) / 100,
          deviation_ratio: Math.round(deviationRatio * 100) / 100,
          severity,
        });
      }
    }

    // Sort by deviation ratio descending
    anomalies.sort((a, b) => b.deviation_ratio - a.deviation_ratio);

    return anomalies;
  }

  /**
   * Day-of-week spending patterns (last 90 days)
   */
  private computeDayPatterns(groupId: number, today: string): DayOfWeekPattern[] {
    const startDate = format(subDays(new Date(today), 90), 'yyyy-MM-dd');

    const stats = database.expenses.getDayOfWeekStats(groupId, startDate, today);
    const topCats = database.expenses.getDayOfWeekTopCategories(groupId, startDate, today);

    if (stats.length === 0) return [];

    // Build top category map
    const topCategoryMap: Record<number, string> = {};
    for (const tc of topCats) {
      topCategoryMap[tc.dow] = tc.category;
    }

    // Compute overall average daily spend
    const totalSpend = stats.reduce((sum, s) => sum + s.total, 0);
    const totalUniqueDays = stats.reduce((sum, s) => sum + s.unique_days, 0);
    const overallDailyAvg = totalUniqueDays > 0 ? totalSpend / totalUniqueDays : 0;

    const patterns: DayOfWeekPattern[] = [];

    for (const stat of stats) {
      const avgDailySpend = stat.unique_days > 0 ? stat.total / stat.unique_days : 0;
      const vsAverage = overallDailyAvg > 0 ? (avgDailySpend / overallDailyAvg) * 100 : 0;

      patterns.push({
        day_of_week: stat.dow,
        day_name: DAY_NAMES[stat.dow] || 'Unknown',
        avg_daily_spend: Math.round(avgDailySpend * 100) / 100,
        total_transactions: stat.tx_count,
        vs_average_percent: Math.round(vsAverage * 10) / 10,
        top_category: topCategoryMap[stat.dow] || 'N/A',
      });
    }

    return patterns.sort((a, b) => a.day_of_week - b.day_of_week);
  }

  /**
   * Spending velocity: last 7 days vs previous 7 days
   * Divide by fixed window size (7), not active_days
   */
  private computeVelocity(groupId: number, today: string): SpendingVelocity {
    const rows = database.expenses.getVelocityData(groupId, today);

    let recentTotal = 0;
    let earlierTotal = 0;

    for (const row of rows) {
      if (row.period === 'recent') {
        recentTotal = row.total;
      } else if (row.period === 'earlier') {
        earlierTotal = row.total;
      }
    }

    // Fixed window size: 7 days
    const period1DailyAvg = earlierTotal / 7;
    const period2DailyAvg = recentTotal / 7;

    const acceleration =
      period1DailyAvg > 0
        ? ((period2DailyAvg - period1DailyAvg) / period1DailyAvg) * 100
        : period2DailyAvg > 0
          ? 100
          : 0;

    let trend: SpendingVelocity['trend'];
    if (Math.abs(acceleration) <= 10) {
      trend = 'stable';
    } else if (acceleration > 0) {
      trend = 'accelerating';
    } else {
      trend = 'decelerating';
    }

    return {
      period_1_daily_avg: Math.round(period1DailyAvg * 100) / 100,
      period_2_daily_avg: Math.round(period2DailyAvg * 100) / 100,
      acceleration: Math.round(acceleration * 10) / 10,
      trend,
    };
  }

  /**
   * Budget utilization rate (total budget vs total spent)
   */
  private computeBudgetUtilization(
    groupId: number,
    currentMonth: string,
    monthStart: string,
    today: string,
  ): BudgetUtilization | null {
    const budgets = database.budgets.getAllBudgetsForMonth(groupId, currentMonth);
    if (budgets.length === 0) return null;

    // Sum all budgets in EUR
    let totalBudgetEur = 0;
    for (const budget of budgets) {
      const limitEur = convertCurrency(budget.limit_amount, budget.currency as CurrencyCode, 'EUR');
      totalBudgetEur += limitEur;
    }

    const totalSpentEur = database.expenses.getTotalEurForRange(groupId, monthStart, today);

    const remaining = totalBudgetEur - totalSpentEur;
    const utilizationPercent = totalBudgetEur > 0 ? (totalSpentEur / totalBudgetEur) * 100 : 0;
    const remainingPercent = totalBudgetEur > 0 ? (remaining / totalBudgetEur) * 100 : 0;

    return {
      total_budget: Math.round(totalBudgetEur * 100) / 100,
      total_spent: Math.round(totalSpentEur * 100) / 100,
      remaining: Math.round(remaining * 100) / 100,
      utilization_percent: Math.round(utilizationPercent * 10) / 10,
      remaining_percent: Math.round(remainingPercent * 10) / 10,
    };
  }

  /**
   * Spending streak: consecutive days above/below average
   * Days without expenses break the streak
   */
  private computeStreak(groupId: number, today: string): SpendingStreak {
    const startDate = format(subDays(new Date(today), 30), 'yyyy-MM-dd');
    const dailyTotals = database.expenses.getDailyTotals(groupId, startDate, today);

    if (dailyTotals.length === 0) {
      return {
        current_streak_days: 0,
        streak_type: 'no_spending',
        avg_daily_during_streak: 0,
        overall_daily_average: 0,
      };
    }

    // Overall average
    const totalSpend = dailyTotals.reduce((sum, d) => sum + d.total, 0);
    const overallDailyAvg = totalSpend / dailyTotals.length;

    // Build a map of date -> total
    const dailyMap: Record<string, number> = {};
    for (const d of dailyTotals) {
      dailyMap[d.date] = d.total;
    }

    // Walk backwards from today
    let streakDays = 0;
    let streakSum = 0;
    let streakType: SpendingStreak['streak_type'] = 'no_spending';
    let currentDate = new Date(today);

    for (let i = 0; i < 30; i++) {
      const dateStr = format(currentDate, 'yyyy-MM-dd');
      const dayTotal = dailyMap[dateStr];

      if (dayTotal === undefined) {
        // No spending this day - breaks streak
        if (streakDays === 0) {
          streakType = 'no_spending';
        }
        break;
      }

      if (streakDays === 0) {
        // First day - determine streak type
        streakType = dayTotal > overallDailyAvg ? 'above_average' : 'below_average';
        streakDays = 1;
        streakSum = dayTotal;
      } else {
        // Check if continues same streak
        const isAbove = dayTotal > overallDailyAvg;
        if (
          (streakType === 'above_average' && isAbove) ||
          (streakType === 'below_average' && !isAbove)
        ) {
          streakDays++;
          streakSum += dayTotal;
        } else {
          break;
        }
      }

      currentDate = subDays(currentDate, 1);
    }

    return {
      current_streak_days: streakDays,
      streak_type: streakType,
      avg_daily_during_streak:
        streakDays > 0 ? Math.round((streakSum / streakDays) * 100) / 100 : 0,
      overall_daily_average: Math.round(overallDailyAvg * 100) / 100,
    };
  }

  /**
   * Monthly projection with confidence level
   * confidence: 'low' if days_elapsed < 7
   */
  private computeProjection(
    groupId: number,
    now: Date,
    currentMonth: string,
    monthStart: string,
    today: string,
  ): MonthlyProjection | null {
    const daysElapsed = now.getDate();
    const daysInMonth = getDaysInMonth(now);

    if (daysElapsed === 0) return null;

    const currentTotal = database.expenses.getTotalEurForRange(groupId, monthStart, today);
    if (currentTotal === 0 && daysElapsed < 3) return null;

    const projectedTotal = (currentTotal / daysElapsed) * daysInMonth;

    // Get last month total for comparison
    const prevMonth = subMonths(now, 1);
    const prevMonthStart = format(startOfMonth(prevMonth), 'yyyy-MM-dd');
    const prevMonthEnd = format(
      new Date(prevMonth.getFullYear(), prevMonth.getMonth() + 1, 0),
      'yyyy-MM-dd',
    );
    const lastMonthTotal = database.expenses.getTotalEurForRange(
      groupId,
      prevMonthStart,
      prevMonthEnd,
    );

    const projectedVsLastMonth = lastMonthTotal > 0 ? (projectedTotal / lastMonthTotal) * 100 : 0;

    // Confidence
    let confidence: MonthlyProjection['confidence'];
    if (daysElapsed < 7) {
      confidence = 'low';
    } else if (daysElapsed >= 20) {
      confidence = 'high';
    } else {
      confidence = 'medium';
    }

    // Category projections
    const currentCatTotals = database.expenses.getCategoryTotals(groupId, monthStart, today);
    const budgets = database.budgets.getAllBudgetsForMonth(groupId, currentMonth);
    const budgetMap: Record<string, { limit: number; currency: string }> = {};
    for (const b of budgets) {
      budgetMap[b.category] = { limit: b.limit_amount, currency: b.currency };
    }

    const categoryProjections: CategoryProjection[] = [];
    for (const cat of currentCatTotals) {
      const catProjected = (cat.total / daysElapsed) * daysInMonth;
      const budget = budgetMap[cat.category];

      let budgetLimitEur: number | null = null;
      let willExceed = false;
      if (budget) {
        budgetLimitEur = convertCurrency(budget.limit, budget.currency as CurrencyCode, 'EUR');
        willExceed = catProjected > budgetLimitEur;
      }

      categoryProjections.push({
        category: cat.category,
        current: Math.round(cat.total * 100) / 100,
        projected: Math.round(catProjected * 100) / 100,
        budget_limit: budgetLimitEur !== null ? Math.round(budgetLimitEur * 100) / 100 : null,
        will_exceed: willExceed,
      });
    }

    // Sort by projected descending
    categoryProjections.sort((a, b) => b.projected - a.projected);

    return {
      days_elapsed: daysElapsed,
      days_in_month: daysInMonth,
      current_total: Math.round(currentTotal * 100) / 100,
      projected_total: Math.round(projectedTotal * 100) / 100,
      projected_vs_last_month: Math.round(projectedVsLastMonth * 10) / 10,
      confidence,
      category_projections: categoryProjections.slice(0, 15),
    };
  }
}

// Singleton instance
export const spendingAnalytics = new SpendingAnalytics();
