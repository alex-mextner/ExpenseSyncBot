// Widget registry — types and registry map for dashboard widgets (stub, filled in task 9)
export interface WidgetConfig {
  id: string;
  type: string;
  position: number;
  config: Record<string, unknown>;
}
