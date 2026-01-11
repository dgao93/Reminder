import AsyncStorage from '@react-native-async-storage/async-storage';

export type Schedule = {
  id: string;
  name: string;
  intervalMinutes: number;
  startMinutesFromMidnight: number;
  endMinutesFromMidnight: number;
  daysOfWeek: boolean[];
  message: string;
  isActive: boolean;
};

export type QuietHours = {
  enabled: boolean;
  startMinutesFromMidnight: number;
  endMinutesFromMidnight: number;
};

export type StoredSettings = {
  schedules: Schedule[];
  quietHours?: QuietHours;
};

const STORAGE_KEY = 'intervals_settings_v2';
const DEFAULT_DAYS = [true, true, true, true, true, true, true];
const DEFAULT_QUIET_HOURS: QuietHours = {
  enabled: false,
  startMinutesFromMidnight: 22 * 60,
  endMinutesFromMidnight: 7 * 60,
};

const normalizeDaysOfWeek = (value: unknown) => {
  if (!Array.isArray(value) || value.length !== 7) {
    return [...DEFAULT_DAYS];
  }
  return value.map((entry) => Boolean(entry));
};

const normalizeMinutes = (value: unknown) => {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return 0;
  }
  const normalized = Math.floor(value) % (24 * 60);
  return normalized < 0 ? normalized + 24 * 60 : normalized;
};

const normalizeQuietHours = (value: unknown): QuietHours => {
  const input = value as Partial<QuietHours> | undefined;
  const enabled = Boolean(input?.enabled);
  const start =
    typeof input?.startMinutesFromMidnight === 'number'
      ? normalizeMinutes(input.startMinutesFromMidnight)
      : DEFAULT_QUIET_HOURS.startMinutesFromMidnight;
  const end =
    typeof input?.endMinutesFromMidnight === 'number'
      ? normalizeMinutes(input.endMinutesFromMidnight)
      : DEFAULT_QUIET_HOURS.endMinutesFromMidnight;

  return {
    enabled,
    startMinutesFromMidnight: start,
    endMinutesFromMidnight: end,
  };
};

export const loadSettings = async (): Promise<StoredSettings | null> => {
  try {
    const raw = await AsyncStorage.getItem(STORAGE_KEY);
    if (!raw) {
      return null;
    }
    const parsed = JSON.parse(raw) as {
      schedules?: unknown;
      isActive?: unknown;
      quietHours?: unknown;
    };
    if (!Array.isArray(parsed.schedules)) {
      return null;
    }
    const defaultActive = typeof parsed.isActive === 'boolean' ? parsed.isActive : false;
    const validSchedules = parsed.schedules
      .filter((schedule) => isValidSchedule(schedule))
      .map((schedule, index) => {
        const normalized = schedule as Schedule;
        return {
          id: normalized.id,
          name:
            typeof normalized.name === 'string'
              ? normalized.name
              : `Notification ${index + 1}`,
          intervalMinutes: normalized.intervalMinutes,
          startMinutesFromMidnight: normalized.startMinutesFromMidnight,
          endMinutesFromMidnight: normalized.endMinutesFromMidnight,
          daysOfWeek: normalizeDaysOfWeek(normalized.daysOfWeek),
          message: normalized.message,
          isActive:
            typeof normalized.isActive === 'boolean' ? normalized.isActive : defaultActive,
        };
      });
    return {
      schedules: validSchedules,
      quietHours: normalizeQuietHours(parsed.quietHours),
    };
  } catch {
    return null;
  }
};

export const saveSettings = async (settings: StoredSettings): Promise<void> => {
  try {
    await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch {
    // Ignore storage errors for now.
  }
};

const isValidSchedule = (value: unknown) => {
  const schedule = value as Schedule;
  const daysValid =
    typeof schedule?.daysOfWeek === 'undefined' ||
    (Array.isArray(schedule.daysOfWeek) && schedule.daysOfWeek.length === 7);
  return (
    typeof schedule?.id === 'string' &&
    typeof schedule.intervalMinutes === 'number' &&
    typeof schedule.startMinutesFromMidnight === 'number' &&
    typeof schedule.endMinutesFromMidnight === 'number' &&
    typeof schedule.message === 'string' &&
    (typeof schedule.name === 'string' || typeof schedule.name === 'undefined') &&
    daysValid
  );
};
