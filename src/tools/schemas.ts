import * as z from "zod/v4";
import type {
  ConvertResult,
  FindResult,
  IsoWeekday,
  MeetingSlot,
  ParticipantSlotView,
  RenderOutput,
  ZonedMoment,
} from "../time/types.js";

const CLOCK_TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const LOCAL_DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?$/;

const timeZoneName = z
  .string()
  .min(1)
  .max(64)
  .describe(
    'IANA time zone name such as "America/New_York" or "Asia/Kolkata". Not an abbreviation.',
  );

const isoWeekday = z.literal([1, 2, 3, 4, 5, 6, 7]);

export const participantInputSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1)
    .max(60)
    .describe("Name or label of the person. Unique in the list."),
  time_zone: timeZoneName,
  work_start: z
    .string()
    .regex(CLOCK_TIME)
    .optional()
    .describe('Start of working hours, 24-hour "HH:mm". Defaults to "09:00".'),
  work_end: z
    .string()
    .regex(CLOCK_TIME)
    .optional()
    .describe(
      'End of working hours, 24-hour "HH:mm". Defaults to "17:00". An end at or before the start means the shift ends the next day.',
    ),
  work_days: z
    .array(isoWeekday)
    .min(1)
    .max(7)
    .optional()
    .describe(
      "ISO weekdays when the shift starts: 1 = Monday ... 7 = Sunday. Defaults to [1,2,3,4,5].",
    ),
});

export const participantsField = z
  .array(participantInputSchema)
  .min(1)
  .max(20)
  .describe(
    "People to schedule. The first entry is the organizer; dates are interpreted in their time zone.",
  );

export const dateField = (description: string) => z.string().regex(DATE).describe(description);

export const localDateTimeField = z
  .string()
  .regex(LOCAL_DATE_TIME)
  .describe('Local date and time without offset, "YYYY-MM-DDTHH:mm", e.g. "2026-03-09T09:00".');

export const convertInputSchema = z.object({
  date_time: localDateTimeField,
  from_time_zone: timeZoneName.describe("IANA time zone in which date_time is expressed."),
  to_time_zones: z.array(timeZoneName).min(1).max(24).describe("IANA time zones to convert into."),
});

export const findInputSchema = z.object({
  participants: participantsField,
  start_date: dateField("First day to search, YYYY-MM-DD, in the organizer's time zone."),
  days: z
    .number()
    .int()
    .min(1)
    .max(14)
    .default(7)
    .describe("How many days to search (1-14). Default 7."),
  duration_minutes: z
    .number()
    .int()
    .min(15)
    .max(480)
    .default(30)
    .describe("Meeting length in minutes (15-480). Default 30."),
  step_minutes: z
    .literal([15, 30, 60])
    .default(30)
    .describe("Granularity of candidate start times: 15, 30 or 60 minutes. Default 30."),
  max_results: z
    .number()
    .int()
    .min(1)
    .max(20)
    .default(5)
    .describe("Maximum slots to return (1-20). Default 5."),
});

export const renderInputSchema = z.object({
  participants: participantsField,
  date: dateField("Day to display, YYYY-MM-DD, in the organizer's time zone."),
});

const weekday: z.ZodType<IsoWeekday> = isoWeekday;

const zonedMomentSchema: z.ZodType<ZonedMoment> = z.object({
  time_zone: z.string(),
  local_date_time: z.string(),
  utc_offset: z.string(),
  weekday,
  day_offset: z.number().int(),
  is_dst: z.boolean(),
});

export const convertOutputSchema: z.ZodType<ConvertResult> = z.object({
  source: zonedMomentSchema,
  requested_date_time: z.string(),
  dst_adjustment: z.enum(["none", "gap", "overlap"]),
  utc: z.string(),
  targets: z.array(zonedMomentSchema),
});

const slotViewSchema: z.ZodType<ParticipantSlotView> = z.object({
  name: z.string(),
  time_zone: z.string(),
  local_start: z.string(),
  local_end: z.string(),
  utc_offset: z.string(),
  weekday,
  available: z.boolean(),
  reason: z.enum(["outside_working_hours", "non_working_day"]).optional(),
});

const slotSchema: z.ZodType<MeetingSlot> = z.object({
  start_utc: z.string(),
  end_utc: z.string(),
  available_count: z.number().int(),
  total_participants: z.number().int(),
  all_available: z.boolean(),
  participants: z.array(slotViewSchema),
});

export const findOutputSchema: z.ZodType<FindResult> = z.object({
  has_full_overlap: z.boolean(),
  slots: z.array(slotSchema),
  searched: z.object({
    start_date: z.string(),
    days: z.number().int(),
    organizer_time_zone: z.string(),
  }),
  summary: z.string(),
});

const gridShape = {
  date: z.string(),
  organizer_time_zone: z.string(),
  start_utc: z.string(),
  rows: z.array(
    z.object({
      name: z.string(),
      time_zone: z.string(),
      utc_offset: z.string(),
      cells: z.array(
        z.object({
          start_utc: z.string(),
          local_time: z.string(),
          local_date: z.string(),
          state: z.enum(["working", "off"]),
        }),
      ),
    }),
  ),
  overlap_columns: z.array(z.number().int()),
};

export const renderOutputSchema: z.ZodType<RenderOutput> = z.object({
  ...gridShape,
  participants: z.array(
    z.object({
      name: z.string(),
      time_zone: z.string(),
      work_start: z.string(),
      work_end: z.string(),
      work_days: z.array(weekday),
    }),
  ),
});
