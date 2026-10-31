import type { Schedule } from "../pentaho/types.js";

export interface EventBridgeSchedule {
  expression: string;
  kind: "rate" | "cron";
  description: string;
  note?: string;
}

function minutes(totalSeconds: number): number {
  return Math.max(1, Math.ceil(totalSeconds / 60));
}

function clock(hour: number, minute: number): { hour: number; minute: number } {
  return {
    hour: Math.min(23, Math.max(0, hour)),
    minute: Math.min(59, Math.max(0, minute)),
  };
}

/**
 * PDI's START entry scheduler types: 0 none, 1 interval, 2 daily, 3 weekly, 4 monthly.
 * EventBridge Scheduler runs cron expressions in UTC; PDI schedules used the server's local
 * time zone, which is not stored in the .kjb file.
 */
export function toEventBridgeSchedule(schedule: Schedule): EventBridgeSchedule | undefined {
  const note = "PDI did not store a time zone; EventBridge Scheduler runs this expression in UTC.";
  if (schedule.schedulerType === 1) {
    const seconds = schedule.intervalSeconds + schedule.intervalMinutes * 60;
    if (seconds <= 0) return undefined;
    const every = minutes(seconds);
    return {
      expression: `rate(${every} ${every === 1 ? "minute" : "minutes"})`,
      kind: "rate",
      description: `Every ${every} minute${every === 1 ? "" : "s"}`,
      note:
        seconds < 60
          ? "PDI intervals below one minute are rounded up because EventBridge Scheduler's minimum rate is one minute."
          : note,
    };
  }
  const { hour, minute } = clock(schedule.hour, schedule.minutes);
  if (schedule.schedulerType === 2) {
    return {
      expression: `cron(${minute} ${hour} * * ? *)`,
      kind: "cron",
      description: `Daily at ${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`,
      note,
    };
  }
  if (schedule.schedulerType === 3) {
    // PDI 1=Monday ... 7=Sunday. EventBridge 1=Sunday ... 7=Saturday.
    const day = ((Math.max(1, Math.min(7, schedule.weekDay)) % 7) + 1) % 7 || 1;
    return {
      expression: `cron(${minute} ${hour} ? * ${day})`,
      kind: "cron",
      description: `Weekly on day ${schedule.weekDay} at ${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`,
      note,
    };
  }
  if (schedule.schedulerType === 4) {
    const day = Math.min(31, Math.max(1, schedule.dayOfMonth));
    return {
      expression: `cron(${minute} ${hour} ${day} * ? *)`,
      kind: "cron",
      description: `Monthly on day ${day} at ${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`,
      note,
    };
  }
  return undefined;
}
