import Constants from 'expo-constants';
import * as Notifications from 'expo-notifications';

import { buildNotificationQueue, ScheduleRule } from './scheduler';
import { QuietHours, Schedule } from './storage';

export const DEFAULT_MESSAGE = "Don't forget!";
export const NOTIFICATION_CATEGORY_ID = 'REMINDER';

const rawAppName =
  Constants.expoConfig?.name ?? (Constants as any).manifest?.name ?? 'Reminder';
export const APP_NAME =
  rawAppName === 'Reminders by Location' ? 'Reminder' : rawAppName;

type QueueOptions = {
  now?: Date;
  maxCount?: number;
  horizonHours?: number;
};

type QuietHoursOptions = {
  quietHours?: QuietHours;
};

export const buildQueue = (targetSchedules: Schedule[], options?: QueueOptions) => {
  const scheduleRules: ScheduleRule[] = targetSchedules.map((schedule) => ({
    id: schedule.id,
    type: schedule.type ?? 'withinDay',
    intervalMinutes: schedule.intervalMinutes,
    startMinutesFromMidnight: schedule.startMinutesFromMidnight,
    endMinutesFromMidnight: schedule.endMinutesFromMidnight,
    message: schedule.message,
    daysOfWeek: schedule.daysOfWeek,
    dayOfMonth: schedule.dayOfMonth,
  }));

  return buildNotificationQueue({
    now: options?.now ?? new Date(),
    schedules: scheduleRules,
    maxCount: options?.maxCount ?? 50,
    horizonHours: options?.horizonHours ?? 24 * 7,
  });
};

export const scheduleBatch = async (
  targetSchedules: Schedule[],
  options?: QueueOptions & QuietHoursOptions
) => {
  const queue = filterQuietHours(buildQueue(targetSchedules, options), options?.quietHours);
  if (queue.length === 0) {
    return { count: 0 };
  }

  const nameById = new Map(targetSchedules.map((schedule) => [schedule.id, schedule.name]));
  let scheduled = 0;
  for (const item of queue) {
    const scheduleName = nameById.get(item.scheduleId) ?? '';
    const titleSuffix = scheduleName.trim() ? ` - ${scheduleName.trim()}` : '';
    try {
      await Notifications.scheduleNotificationAsync({
        content: {
          title: `${APP_NAME}${titleSuffix}`,
          body: item.message.trim() || DEFAULT_MESSAGE,
          sound: 'default',
          categoryIdentifier: NOTIFICATION_CATEGORY_ID,
          data: { scheduleId: item.scheduleId },
        },
        trigger: {
          type: 'date',
          date: item.date,
        },
      });
      scheduled += 1;
    } catch (error) {
      try {
        await Promise.all(
          targetSchedules.map((schedule) => cancelScheduleNotifications(schedule.id))
        );
      } catch {
        // Ignore cancellation errors after schedule failures.
      }
      return { count: 0, error: formatError(error) };
    }
  }

  return { count: scheduled };
};

export const cancelScheduleNotifications = async (scheduleId: string) => {
  const scheduled = await Notifications.getAllScheduledNotificationsAsync();
  const matches = scheduled.filter((item) => {
    const data = item.content?.data as { scheduleId?: string } | undefined;
    return data?.scheduleId === scheduleId;
  });
  for (const item of matches) {
    await Notifications.cancelScheduledNotificationAsync(item.identifier);
  }
  return matches.length;
};

const formatError = (error: unknown) => {
  if (error instanceof Error && error.message) {
    return error.message;
  }
  return 'Please try again.';
};

const filterQuietHours = (queue: ReturnType<typeof buildQueue>, quietHours?: QuietHours) => {
  if (!quietHours?.enabled) {
    return queue;
  }
  const startMinutes = quietHours.startMinutesFromMidnight;
  const endMinutes = quietHours.endMinutesFromMidnight;
  if (startMinutes === endMinutes) {
    return queue;
  }
  const spansMidnight = endMinutes < startMinutes;
  return queue.filter((item) => {
    const minutes = item.date.getHours() * 60 + item.date.getMinutes();
    if (!spansMidnight) {
      return minutes < startMinutes || minutes >= endMinutes;
    }
    return minutes < startMinutes && minutes >= endMinutes;
  });
};
