# Benchmark Data Integration — Design Spec

## Overview

Integrate publicly available household income and expenditure statistics into the bot to provide contextual comparisons, smart defaults, and data-driven insights. Users see how their spending compares to typical households in their country and income bracket.

## Data Sources

### Primary Sources

| Source | Coverage | Format | Content | Update Frequency |
|--------|----------|--------|---------|------------------|
| **OECD COICOP** | 37-38 countries (EU, US, JP, KR, AU...) | JSON via stats.oecd.org API | % household spending by category (housing, food, transport, health, recreation...) | Annual |
| **WID (wid.world)** | 100+ countries incl. RU, RS, IN, CN | CSV: `country, variable, percentile, year, value` | Income/wealth distribution by percentile (p50, p90, p99) | Annual |
| **BLS Consumer Expenditure Survey** | US only | CSV (clean, documented) | Spending by 14 categories × 5 income quintiles; Q1 ~$35k/yr → Q5 ~$150k/yr; data since 1980 | Annual |
| **Our World in Data** | 190 countries | CSV | Median income per person per day (PPP $) | Annual |

### Secondary Sources

| Source | Coverage | Notes |
|--------|----------|-------|
| **World Bank Microdata** | 100+ developing countries | Raw Stata/CSV, requires heavy preprocessing |
| **OECD Household Saving Rate** | 37 countries | Net saving as % of disposable income |

### Data Storage Strategy

Pre-process all sources into compact static JSON files bundled with the project. No runtime API calls — data changes once a year at most. Estimated size: <500KB total.

```
src/data/benchmarks/
  oecd-expenditure.json    # % by COICOP category per country
  wid-income-percentiles.json  # income distribution per country
  bls-quintiles.json       # US spending by category × quintile
  median-income.json       # median daily income per country (OWID)
  saving-rates.json        # household saving rate per country
```

### Country Coverage Gaps

- **OECD COICOP**: no Russia, Serbia, India, China, most of CIS
- **WID**: broad coverage including CIS — fills the gap for income percentiles
- **Our World in Data**: 190 countries — fills the gap for median income
- For countries outside OECD: use OWID median income + WID percentiles; no category-level spending breakdown available

## Foundation: Required Infrastructure

### F1. Country Code on Group (`groups.country_code`)

New column in `groups` table. ISO 3166-1 alpha-2 (e.g., `DE`, `RS`, `US`). Set during onboarding or via `/settings`. All benchmark features depend on this.

### F2. Category → COICOP Mapping

User categories ("кафе", "продукты", "аренда") must map to COICOP divisions for comparison. Two approaches:

- **AI mapping** (recommended): when a new category is created, LLM maps it to COICOP code. Stored in `categories.coicop_code`. Transparent, automatic, user can override.
- **Manual mapping table**: predefined map of common Russian/English category names → COICOP. Faster but less flexible.

COICOP divisions (12):
- CP01 Food & non-alcoholic beverages
- CP02 Alcoholic beverages & tobacco
- CP03 Clothing & footwear
- CP04 Housing, water, energy
- CP05 Furnishings & household equipment
- CP06 Health
- CP07 Transport
- CP08 Communications
- CP09 Recreation & culture
- CP10 Education
- CP11 Restaurants & hotels
- CP12 Miscellaneous goods & services

## Feature Ideas — Organized by CJM Stage

### Stage 1: Onboarding

#### 1. Welcome Benchmark
After `/connect`, show: "Average family in [Germany] spends €3,200/month. Let's see where you are."
- **JTBD**: Give purpose to tracking — not just logging, but comparing
- **Trigger**: Social proof, anchoring
- **Data**: OWID median income + OECD expenditure
- **Effort**: Low

#### 2. Country Profile Step
Add "What country does your group live in?" to onboarding. Saves `country_code`. Unlocks all benchmark features.
- **JTBD**: Foundation
- **Effort**: Low (DB migration + onboarding step)

#### 3. Starter Budget Pack
After country selection: "Create recommended budgets for [Germany]?" — auto-creates 5-7 budgets based on OECD proportions × user's stated total.
- **JTBD**: Lower barrier to budget creation
- **Trigger**: Status quo bias (pre-filled = adopted)
- **Data**: OECD COICOP
- **Effort**: Medium

### Stage 2: First Expenses (First Week)

#### 4. First Expense Reaction
On the first expense in a category: "Coffee €4.50 — average German spends ~€95/month on cafés."
- **JTBD**: "Aha moment", immediate value from tracking
- **Trigger**: Anchoring
- **Data**: OECD COICOP
- **Effort**: Low

#### 5. Category Auto-Mapping to COICOP
When a new category is added, AI maps it to COICOP and stores the link. Enables all comparison features without manual setup.
- **JTBD**: Zero-config benchmarking
- **Effort**: Medium (AI call + DB field)

### Stage 3: Regular Tracking (Daily)

#### 6. Milestone Notifications
"You logged 100 expenses! Average spend: €2,800/month → 62nd percentile in Germany."
- **JTBD**: Sense of progress
- **Trigger**: Gamification, goal gradient
- **Data**: WID income percentiles
- **Effort**: Low

#### 7. Daily Digest with Benchmark Context
In `/advice`: "Today: €87 spent (food €45, transport €42). Average daily spend in Germany: ~€107."
- **JTBD**: Contextualize the routine
- **Trigger**: Anchoring
- **Data**: OECD COICOP (daily = monthly / 30)
- **Effort**: Low (already have /advice)

### Stage 4: Analysis & Review (Weekly/Monthly)

#### 8. "You vs Country" in /stats
Add a section to `/stats`: your % by category vs country median.
```
Category     | You   | Germany | Δ
Food         | 18%   | 12%     | +50% ⚠️
Housing      | 25%   | 25%     | ok
Transport    | 5%    | 9%      | -44% ✓
Entertainment| 12%   | 8%      | +50% ⚠️
```
- **JTBD**: "How am I doing?"
- **Trigger**: Social proof, loss aversion (overspending highlighted)
- **Data**: OECD COICOP
- **Effort**: Medium

#### 9. Benchmark Line in /sum
`/sum food` → "Total: €450 this month. Average family in [country]: €380/month."
- **JTBD**: Instant context for any category
- **Trigger**: Anchoring
- **Data**: OECD COICOP
- **Effort**: Low

#### 10. Trend vs Country Trend
"Your housing costs +12% this year. In Germany housing +3%/year. You're growing 4x faster than average."
- **JTBD**: Detect structural drift
- **Trigger**: Loss aversion
- **Data**: OECD COICOP (multi-year)
- **Effort**: Medium (SpendingAnalytics already computes trends)

#### 11. Income Percentile (WID)
If group specifies monthly income → show percentile: "Your income $3,500/month → top 18% in Russia."
- **JTBD**: Self-awareness, motivation
- **Trigger**: Social proof
- **Data**: WID
- **Effort**: Medium (needs income input)

#### 12. Quintile Self-Assessment Without Income
Estimate income quintile from spending patterns alone. Privacy-friendly.
"By spending patterns, you're closest to quintile 3-4 in Germany (~€3,800/month income)."
- **JTBD**: Insight without sensitive data
- **Data**: BLS CES quintile data + OECD
- **Effort**: High (statistical modeling)

#### 13. Monthly Benchmark Report
End-of-month auto-message: category-by-category comparison with country median. Categories above norm flagged.
- **JTBD**: Periodic health check
- **Trigger**: Social proof, goal gradient
- **Data**: OECD COICOP
- **Effort**: Medium

### Stage 5: Budgeting

#### 14. Budget Health Score
Score 0-100 based on: (a) alignment with country proportions, (b) saving rate vs country norm, (c) budget coverage of major categories.
"Financial health: 67/100. No budget for transport (9% of country avg spending)."
- **JTBD**: Single KPI for financial fitness
- **Trigger**: Gamification
- **Data**: OECD COICOP + saving rates
- **Effort**: Medium

#### 15. "What to Cut First" Recommendation
If a category is significantly above country norm AND discretionary → suggest cutting it first.
"Restaurants: 2.8x above median — top candidate for optimization."
- **JTBD**: Actionable advice
- **Trigger**: Loss aversion
- **Data**: OECD COICOP
- **Effort**: Low (logic on top of #8 data)

#### 16. Saving Rate Comparison
OECD household saving rate by country. "In Germany families save 16% on average. Your estimated saving rate: ~8%."
- **JTBD**: Savings motivation
- **Data**: OECD saving rates
- **Effort**: Medium (needs income or estimation)

### Stage 6: Long-Term Planning

#### 17. Relocation Simulator
"What if we move to Portugal?" → AI computes: "Your €3,200/month in Germany → ~€2,400/month in Portugal (PPP-adjusted). Housing -35%, food -20%. Saving potential: +€800/month."
- **JTBD**: Life planning
- **Data**: OECD COICOP + PPP data
- **Effort**: High

#### 18. "When Will I Reach the Norm" Projection
If expenses are declining toward median: "At current trend (-3%/month on food), you'll reach Germany's median in 4 months."
- **JTBD**: Goal visibility
- **Trigger**: Goal gradient
- **Data**: OECD COICOP
- **Effort**: Medium (SpendingAnalytics already has projections)

#### 19. Life Stage Benchmarks
BLS CES + OECD provide age-group data. "Family 25-34 in Germany spends 4% on health. By 45-54 it's typically 8%."
- **JTBD**: Long-term awareness
- **Data**: BLS CES (US), OECD (limited)
- **Effort**: Medium

#### 20. Global Wealth Percentile
WID global distribution. "Globally, your spending puts you in the top 7% of world population."
- **JTBD**: Perspective shift
- **Data**: WID global data
- **Effort**: Low

### Stage 7: Social & Group Context

#### 21. "Did You Know?" Daily Facts
In `/advice`: "Japanese families spend 17% on food — one of the highest in OECD."
- **JTBD**: Engagement, conversation starter
- **Data**: OECD COICOP
- **Effort**: Low

#### 22. Anonymous Group vs Group
If bot serves multiple groups in same country — anonymous aggregate: "You spend less on entertainment than 70% of groups in your country."
- **JTBD**: Social proof without privacy violation
- **Trigger**: Social proof
- **Effort**: High (needs aggregation + anonymization)

#### 23. Country Challenge
Monthly challenge: live within median budget of another country. "Challenge 🇯🇵: food ≤17%, transport ≤8%."
- **JTBD**: Gamification + education
- **Trigger**: Gamification
- **Data**: OECD COICOP
- **Effort**: Medium

### AI Integration (Cross-Cutting)

#### 24. Benchmark Context in AI System Prompt
Add country benchmark data to AI's system prompt. LLM then naturally references benchmarks: "Your transport spending is 40% above German median."
- **JTBD**: Smarter, more contextual AI advice
- **Data**: OECD COICOP
- **Effort**: Low — highest ROI feature

#### 25. Contextual Anomalies in AI
SpendingAnalytics already detects anomalies within user history. Add external benchmark: "Category [restaurants] is anomalous both for your history AND for your country — 2.8x above median."
- **JTBD**: Double-validated insights
- **Data**: OECD COICOP
- **Effort**: Low (on top of existing anomaly detection)

#### 26. Country Comparison via AI Chat
Natural language: `@ExpenseSyncBot how does our spending compare to the average Serbian family?` — AI composes the answer from benchmark data.
- **JTBD**: Conversational access to all benchmark data
- **Data**: All sources
- **Effort**: Low (if #24 is done, AI handles this naturally)

#### 27. Seasonal Benchmark
BLS CES has quarterly data. AI mentions: "By US data, December spending spikes 20%+ — do you see the same pattern?"
- **JTBD**: Seasonal awareness
- **Data**: BLS CES
- **Effort**: Low

#### 28. PPP-Normalized Comparison
Convert spending through PPP for cross-country comparison. "In PPP terms, your spending is equivalent to an American family earning $68k/year — 60th percentile in the US."
- **JTBD**: Apples-to-apples comparison
- **Data**: World Bank PPP + BLS CES
- **Effort**: Medium

## Behavioral Economics Matrix

| Trigger | Mechanism | Features Using It |
|---------|-----------|-------------------|
| **Anchoring** | Show the "norm" BEFORE user evaluates their own spending | #4, #7, #8, #9 |
| **Social proof** | "Average family spends X" | #1, #8, #13, #22 |
| **Loss aversion** | "You're overpaying Y€/month vs median" | #10, #15, #24 |
| **Goal gradient** | Progress toward "norm" visible | #18, #14, #6 |
| **Status quo bias** | Pre-filled budgets get adopted | #3 |
| **Gamification** | Scores, milestones, challenges | #6, #14, #23 |

## Priority Matrix

### P0 — Foundation (must do first)
| # | Feature | Effort |
|---|---------|--------|
| F1 | `groups.country_code` field + onboarding step | Low |
| F2 | Category → COICOP mapping (AI-based) | Medium |
| — | Pre-process and bundle static JSON benchmark data | Medium |

### P1 — High Value / Low Effort
| # | Feature | Why |
|---|---------|-----|
| 24 | Benchmark context in AI prompt | Unlocks #25, #26, #27 for free via LLM |
| 8 | "You vs Country" in /stats | Most requested type of insight |
| 9 | Benchmark line in /sum | One-line addition to existing output |
| 2 | Country profile step in onboarding | Enables everything |

### P2 — High Value / Medium Effort
| # | Feature | Why |
|---|---------|-----|
| 3 | Starter budget pack | Reduces onboarding friction |
| 13 | Monthly benchmark report | Recurring engagement |
| 14 | Budget health score | Single KPI |
| 11 | Income percentile (WID) | Compelling insight |

### P3 — Nice to Have
| # | Feature | Why |
|---|---------|-----|
| 17 | Relocation simulator | Cool but niche |
| 22 | Group vs group | Needs critical mass |
| 12 | Quintile self-assessment | Complex statistics |
| 23 | Country challenge | Gamification experiment |

## Open Questions

1. **Country for CIS users**: OECD has no Russia/Ukraine/Serbia data for COICOP categories. Options: (a) use WID income percentiles only; (b) source Rosstat/national stats; (c) use "closest OECD country" proxy (e.g., Turkey for Russia).
2. **Household size normalization**: OECD data is per household. Should we adjust for household size? BLS CES has "consumer unit" size data.
3. **Income input**: Several features (#11, #16, #17) benefit from knowing income. Privacy concern — optional field, never shared.
4. **COICOP mapping accuracy**: AI mapping needs validation. Consider showing user the mapping once and letting them confirm/correct.
5. **Data freshness**: How to handle when the bundled JSON is 1+ year old? Show data year in output.
