import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert,
  Animated,
  InteractionManager,
  Keyboard,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  useWindowDimensions,
  View,
} from 'react-native';
import DateTimePicker, { DateTimePickerEvent } from '@react-native-community/datetimepicker';
import MaterialIcons from '@expo/vector-icons/MaterialIcons';
import MaterialCommunityIcons from '@expo/vector-icons/MaterialCommunityIcons';
import { StatusBar } from 'expo-status-bar';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Gesture, GestureDetector, GestureHandlerRootView } from 'react-native-gesture-handler';
import Reanimated, {
  runOnJS,
  useAnimatedScrollHandler,
  useAnimatedStyle,
  useSharedValue,
  withSpring,
  withTiming,
} from 'react-native-reanimated';
import { BlurView } from 'expo-blur';
import { LinearGradient } from 'expo-linear-gradient';
import * as Notifications from 'expo-notifications';
import { SafeAreaProvider, SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';

import { ColorSchemeProvider, useColorScheme, useDarkModeToggle } from './hooks/use-color-scheme';
import {
  cancelScheduleNotifications,
  DEFAULT_MESSAGE,
  APP_NAME,
  NOTIFICATION_CATEGORY_ID,
  scheduleBatch as scheduleNotificationsBatch,
} from './src/notifications';
import {
  loadSettings,
  saveSettings,
  Schedule,
  ScheduleType,
  StoredSettings,
  QuietHours,
} from './src/storage';

const MIN_INTERVAL = 5;
const MAX_INTERVAL = 180;
const DEFAULT_DAYS = [true, true, true, true, true, true, true];
const DEFAULT_DAY_OF_MONTH = 1;
const OVERNIGHT_NOTICE_KEY = 'settings.overnightNoticeShown';
const DAY_LABELS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const FONT_REGULAR = 'System';
const FONT_MEDIUM = 'System';
const FONT_BOLD = 'System';
const FONT_SIZE_XS = 12;
const FONT_SIZE_SM = 14;
const FONT_SIZE_MD = 16;
const FONT_SIZE_LG = 18;
const FONT_SIZE_XL = 20;
const FONT_SIZE_TITLE = 34;
const FONT_SIZE_DISPLAY = 36;
const TAB_BAR_HEIGHT = 56;
const DEFAULT_QUIET_HOURS: QuietHours = {
  enabled: false,
  startMinutesFromMidnight: 22 * 60,
  endMinutesFromMidnight: 7 * 60,
};
const ONBOARDING_KEY = 'settings.onboardingSeen';
const NOTIFICATION_ACTION_SNOOZE_PREFIX = 'SNOOZE_';
const NOTIFICATION_ACTION_SKIP = 'SKIP_NEXT';
type ScheduleResult = { count: number; error?: string };

const SCHEDULE_TYPE_OPTIONS: Array<{ value: ScheduleType; label: string; helper: string }> = [
  {
    value: 'withinDay',
    label: 'Intraday',
    helper: 'Multiple reminders within a start and end time.',
  },
  {
    value: 'daily',
    label: 'Daily',
    helper: 'One reminder every day at a chosen time.',
  },
  {
    value: 'weekly',
    label: 'Weekly',
    helper: 'Pick days of the week and a time.',
  },
  {
    value: 'monthly',
    label: 'Monthly',
    helper: 'Pick a day of the month and a time.',
  },
];

const getDefaultNotificationName = (index: number) => `Notification ${index + 1}`;
const normalizeDaysOfWeek = (value?: boolean[]) => {
  if (!Array.isArray(value) || value.length !== 7) {
    return DEFAULT_DAYS;
  }
  return value.map((entry) => Boolean(entry));
};

const getScheduleType = (value?: ScheduleType): ScheduleType => value ?? 'withinDay';

const clampDayOfMonth = (value: number) => {
  if (!Number.isFinite(value)) {
    return DEFAULT_DAY_OF_MONTH;
  }
  const normalized = Math.round(value);
  if (normalized < 1) {
    return 1;
  }
  if (normalized > 31) {
    return 31;
  }
  return normalized;
};

const normalizeDayOfMonth = (value?: number) =>
  clampDayOfMonth(typeof value === 'number' ? value : new Date().getDate());

const getWeeklyDefaultDays = () => {
  const today = new Date();
  const jsDay = today.getDay();
  const index = jsDay === 0 ? 6 : jsDay - 1;
  return DEFAULT_DAYS.map((_, dayIndex) => dayIndex === index);
};

const areDaysEqual = (left?: boolean[], right?: boolean[]) => {
  const leftDays = normalizeDaysOfWeek(left);
  const rightDays = normalizeDaysOfWeek(right);
  return leftDays.every((value, index) => value === rightDays[index]);
};

const isOvernightWindow = (startMinutes: number, endMinutes: number) =>
  endMinutes < startMinutes;

const formatDaysSummary = (daysOfWeek: boolean[]) => {
  if (daysOfWeek.every(Boolean)) {
    return 'Daily';
  }
  const isWeekdays = daysOfWeek.slice(0, 5).every(Boolean) && daysOfWeek.slice(5).every((v) => !v);
  if (isWeekdays) {
    return 'Weekdays';
  }
  const isWeekends = daysOfWeek.slice(0, 5).every((v) => !v) && daysOfWeek.slice(5).every(Boolean);
  if (isWeekends) {
    return 'Weekends';
  }
  const selected = DAY_LABELS.filter((_, index) => daysOfWeek[index]);
  if (selected.length === 0) {
    return 'No days';
  }
  return selected.join(', ');
};

const formatWeeklyDaysSummary = (daysOfWeek: boolean[]) => {
  if (daysOfWeek.every(Boolean)) {
    return 'Every day';
  }
  return formatDaysSummary(daysOfWeek);
};

const formatOrdinal = (value: number) => {
  const mod100 = value % 100;
  if (mod100 >= 11 && mod100 <= 13) {
    return `${value}th`;
  }
  const mod10 = value % 10;
  if (mod10 === 1) {
    return `${value}st`;
  }
  if (mod10 === 2) {
    return `${value}nd`;
  }
  if (mod10 === 3) {
    return `${value}rd`;
  }
  return `${value}th`;
};

const formatDayOfMonthLabel = (dayOfMonth: number) => `${formatOrdinal(dayOfMonth)} of month`;

const withAlpha = (hex: string, alpha: number) => {
  const normalized = hex.replace('#', '');
  if (normalized.length !== 6) {
    return `rgba(0, 0, 0, ${alpha})`;
  }
  const red = Number.parseInt(normalized.slice(0, 2), 16);
  const green = Number.parseInt(normalized.slice(2, 4), 16);
  const blue = Number.parseInt(normalized.slice(4, 6), 16);
  return `rgba(${red}, ${green}, ${blue}, ${alpha})`;
};

const formatTimeRangeSummary = (startMinutes: number, endMinutes: number) => {
  if (startMinutes === endMinutes) {
    return 'All day';
  }
  return `${formatTime(startMinutes)} - ${formatTime(endMinutes)}`;
};

const createSchedule = (name: string, type: ScheduleType): Schedule => {
  const startMinutes = 9 * 60;
  const endMinutes = type === 'withinDay' ? 21 * 60 : startMinutes;
  const daysOfWeek = type === 'weekly' ? getWeeklyDefaultDays() : DEFAULT_DAYS.slice();
  return {
    id: `${Date.now()}_${Math.random().toString(16).slice(2)}`,
    name,
    type,
    intervalMinutes: 30,
    startMinutesFromMidnight: startMinutes,
    endMinutesFromMidnight: endMinutes,
    daysOfWeek,
    dayOfMonth: type === 'monthly' ? normalizeDayOfMonth() : undefined,
    message: '',
    isActive: false,
  };
};

const DEFAULT_SETTINGS: StoredSettings = {
  schedules: [createSchedule(getDefaultNotificationName(0), 'withinDay')],
  quietHours: DEFAULT_QUIET_HOURS,
};


Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowAlert: true,
    shouldPlaySound: true,
    shouldSetBadge: false,
  }),
});

function AppContent() {
  const colorScheme = useColorScheme();
  const colors = colorScheme === 'dark' ? darkColors : lightColors;
  const { isDarkMode, setDarkMode } = useDarkModeToggle();
  const [activeTab, setActiveTab] = useState<'home' | 'settings'>('home');
  const [darkModeDraft, setDarkModeDraft] = useState(isDarkMode);
  const insets = useSafeAreaInsets();
  const [schedules, setSchedules] = useState<Schedule[]>(DEFAULT_SETTINGS.schedules);
  const [quietHours, setQuietHours] = useState<QuietHours>(DEFAULT_QUIET_HOURS);
  const [authorizationStatus, setAuthorizationStatus] = useState<'authorized' | 'denied' | 'unknown'>(
    'unknown'
  );
  const [, setInlineMessage] = useState('');
  const [activePicker, setActivePicker] = useState<null | { scheduleId: string; kind: 'start' | 'end' }>(
    null
  );
  const [isListEditing, setIsListEditing] = useState(false);
  const [detailScheduleId, setDetailScheduleId] = useState<string | null>(null);
  const [detailMode, setDetailMode] = useState<'add' | 'edit' | null>(null);
  const [isDetailSheetVisible, setIsDetailSheetVisible] = useState(false);
  const [draftSchedule, setDraftSchedule] = useState<Schedule | null>(null);
  const [hasSeenOvernightNotice, setHasSeenOvernightNotice] = useState(false);
  const [isOvernightNoticeLoaded, setIsOvernightNoticeLoaded] = useState(false);
  const [isHydrated, setIsHydrated] = useState(false);
  const [intervalDrafts, setIntervalDrafts] = useState<Record<string, string>>({});
  const [isOnboardingVisible, setIsOnboardingVisible] = useState(false);
  const [hasSeenOnboarding, setHasSeenOnboarding] = useState(false);
  const [isOnboardingLoaded, setIsOnboardingLoaded] = useState(false);
  const previousSchedulesRef = useRef<Schedule[]>([]);
  const schedulesRef = useRef<Schedule[]>(schedules);
  const rescheduleTimers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const { height: windowHeight } = useWindowDimensions();
  const detailSheetOffset = useSharedValue(windowHeight);
  const detailScrollY = useSharedValue(0);
  const darkModeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [keyboardHeight, setKeyboardHeight] = useState(0);
  const [dayOfMonthDrafts, setDayOfMonthDrafts] = useState<Record<string, string>>({});
  const [headerHeight, setHeaderHeight] = useState(0);
  const [settingsHeaderHeight, setSettingsHeaderHeight] = useState(0);
  const scrollY = useRef(new Animated.Value(0)).current;
  const settingsScrollY = useRef(new Animated.Value(0)).current;
  const [scrollViewHeight, setScrollViewHeight] = useState(0);
  const [scrollContentHeight, setScrollContentHeight] = useState(0);

  useEffect(() => {
    if (activeTab === 'home') {
      return;
    }
    setActivePicker(null);
    setDetailScheduleId(null);
    setDetailMode(null);
    setDraftSchedule(null);
    setIsDetailSheetVisible(false);
    detailSheetOffset.value = windowHeight;
    setIsListEditing(false);
    Keyboard.dismiss();
  }, [activeTab, detailSheetOffset, windowHeight]);

  useEffect(() => {
    const hydrate = async () => {
      const stored = await loadSettings();
      if (stored?.schedules?.length) {
        setSchedules(
          stored.schedules.map((schedule) => ({
            ...schedule,
            message: schedule.message === DEFAULT_MESSAGE ? '' : schedule.message,
            isActive: schedule.isActive ?? false,
          }))
        );
      }
      setQuietHours(stored?.quietHours ?? DEFAULT_QUIET_HOURS);
      await refreshAuthorization();
      setIsHydrated(true);
    };
    void hydrate();
  }, []);

  useEffect(() => {
    let isMounted = true;
    AsyncStorage.getItem(OVERNIGHT_NOTICE_KEY)
      .then((value) => {
        if (!isMounted) {
          return;
        }
        if (value === 'true') {
          setHasSeenOvernightNotice(true);
        }
      })
      .catch(() => {})
      .finally(() => {
        if (isMounted) {
          setIsOvernightNoticeLoaded(true);
        }
      });
    return () => {
      isMounted = false;
    };
  }, []);

  useEffect(() => {
    let isMounted = true;
    AsyncStorage.getItem(ONBOARDING_KEY)
      .then((value) => {
        if (!isMounted) {
          return;
        }
        if (value === 'true') {
          setHasSeenOnboarding(true);
        }
      })
      .catch(() => {})
      .finally(() => {
        if (isMounted) {
          setIsOnboardingLoaded(true);
        }
      });
    return () => {
      isMounted = false;
    };
  }, []);

  useEffect(() => {
    setDarkModeDraft(isDarkMode);
  }, [isDarkMode]);

  useEffect(() => {
    return () => {
      if (darkModeTimerRef.current) {
        clearTimeout(darkModeTimerRef.current);
        darkModeTimerRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    if (!isHydrated) {
      return;
    }
    void saveSettings({
      schedules,
      quietHours,
    });
  }, [schedules, quietHours, isHydrated]);

  useEffect(() => {
    schedulesRef.current = schedules;
  }, [schedules]);

  useEffect(() => {
    if (!isHydrated || !isOvernightNoticeLoaded || hasSeenOvernightNotice) {
      return;
    }
    const hasOvernight = schedules.some((schedule) => {
      const scheduleType = getScheduleType(schedule.type);
      if (scheduleType !== 'withinDay') {
        return false;
      }
      return isOvernightWindow(schedule.startMinutesFromMidnight, schedule.endMinutesFromMidnight);
    });
    if (!hasOvernight) {
      return;
    }
    Alert.alert(
      'Overnight window',
      'Alerts after midnight count as the next day. Example: a Mon 9:00 PM - 6:00 AM window needs Tue selected for after-midnight alerts.'
    );
    setHasSeenOvernightNotice(true);
    AsyncStorage.setItem(OVERNIGHT_NOTICE_KEY, 'true').catch(() => {});
  }, [schedules, isHydrated, hasSeenOvernightNotice, isOvernightNoticeLoaded]);

  useEffect(() => {
    if (!isHydrated || !isOnboardingLoaded || hasSeenOnboarding) {
      return;
    }
    setIsOnboardingVisible(true);
  }, [isHydrated, isOnboardingLoaded, hasSeenOnboarding]);

  useEffect(() => {
    const sub = Keyboard.addListener('keyboardWillChangeFrame', (event) => {
      const height = event.endCoordinates?.height ?? 0;
      setKeyboardHeight(Math.max(0, height));
    });
    return () => {
      sub.remove();
    };
  }, []);

  useEffect(() => {
    if (!isHydrated) {
      return;
    }
    const activeSchedules = schedules.filter((schedule) => schedule.isActive);
    activeSchedules.forEach((schedule) => {
      void rescheduleSchedule(schedule, { silent: true, preserveActive: true });
    });
  }, [quietHours, isHydrated]);

  useEffect(() => {
    if (!isHydrated) {
      return;
    }
    const previousSchedules = previousSchedulesRef.current;
    const previousById = new Map(previousSchedules.map((schedule) => [schedule.id, schedule]));
    for (const schedule of schedules) {
      const previous = previousById.get(schedule.id);
      if (!previous || !schedule.isActive || !previous.isActive) {
        continue;
      }
      const hasChanged =
        schedule.type !== previous.type ||
        schedule.intervalMinutes !== previous.intervalMinutes ||
        schedule.startMinutesFromMidnight !== previous.startMinutesFromMidnight ||
        schedule.endMinutesFromMidnight !== previous.endMinutesFromMidnight ||
        schedule.dayOfMonth !== previous.dayOfMonth ||
        schedule.message !== previous.message ||
        !areDaysEqual(schedule.daysOfWeek, previous.daysOfWeek);
      if (hasChanged) {
        debouncedReschedule(schedule);
      }
    }
    previousSchedulesRef.current = schedules;
  }, [schedules, isHydrated]);

  const refreshAuthorization = async () => {
    const settings = await Notifications.getPermissionsAsync();
    if (settings.status === 'granted') {
      setAuthorizationStatus('authorized');
      return;
    }
    if (settings.status === 'denied') {
      setAuthorizationStatus('denied');
      return;
    }
    setAuthorizationStatus('unknown');
  };

  const requestAuthorization = async () => {
    const response = await Notifications.requestPermissionsAsync();
    if (response.granted) {
      setAuthorizationStatus('authorized');
      return true;
    }
    setAuthorizationStatus('denied');
    return false;
  };

  const sendTestNotification = async (schedule: Schedule) => {
    const trimmedName = schedule.name?.trim() ?? '';
    const titleSuffix = trimmedName ? ` - ${trimmedName}` : '';
    const message = schedule.message.trim() || DEFAULT_MESSAGE;
    const granted =
      authorizationStatus === 'authorized' ? true : await requestAuthorization();
    if (!granted) {
      Alert.alert(
        'Notifications off',
        'Enable notifications in Settings to send a test alert.'
      );
      return;
    }
    try {
      await Notifications.scheduleNotificationAsync({
        content: {
          title: `${APP_NAME}${titleSuffix}`,
          body: message,
          sound: 'default',
          data: { scheduleId: schedule.id, isTest: true },
        },
        trigger: {
          type: 'date',
          date: new Date(Date.now() + 1000),
        },
      });
    } catch (error) {
      Alert.alert('Test notification failed', formatError(error));
    }
  };

  const clearRescheduleTimer = (scheduleId: string) => {
    const existing = rescheduleTimers.current.get(scheduleId);
    if (existing) {
      clearTimeout(existing);
      rescheduleTimers.current.delete(scheduleId);
    }
  };

  const getScheduleById = (scheduleId?: string) => {
    if (!scheduleId) {
      return undefined;
    }
    return schedulesRef.current.find((schedule) => schedule.id === scheduleId);
  };

  const getScheduledNotificationDate = (
    request: Notifications.NotificationRequest
  ): Date | null => {
    const trigger = request.trigger as { date?: string | number | Date } | null;
    if (!trigger || typeof trigger !== 'object' || !('date' in trigger)) {
      return null;
    }
    const rawDate = trigger.date;
    if (!rawDate) {
      return null;
    }
    const date = rawDate instanceof Date ? rawDate : new Date(rawDate);
    return Number.isNaN(date.getTime()) ? null : date;
  };

  const cancelNextScheduledNotification = async (scheduleId: string) => {
    const scheduled = await Notifications.getAllScheduledNotificationsAsync();
    const upcoming = scheduled
      .map((item) => {
        const data = item.content?.data as { scheduleId?: string } | undefined;
        if (data?.scheduleId !== scheduleId) {
          return null;
        }
        const date = getScheduledNotificationDate(item);
        if (!date) {
          return null;
        }
        return { id: item.identifier, date };
      })
      .filter(
        (item): item is { id: string; date: Date } =>
          Boolean(item) && item.date.getTime() > Date.now()
      )
      .sort((a, b) => a.date.getTime() - b.date.getTime());
    const next = upcoming[0];
    if (!next) {
      return false;
    }
    await Notifications.cancelScheduledNotificationAsync(next.id);
    return true;
  };

  const scheduleSnooze = async (scheduleId: string, minutes: number) => {
    const schedule = getScheduleById(scheduleId);
    const titleSuffix = schedule?.name?.trim() ? ` - ${schedule.name.trim()}` : '';
    await Notifications.scheduleNotificationAsync({
      content: {
        title: `Snoozed${titleSuffix}`,
        body: schedule?.message?.trim() || DEFAULT_MESSAGE,
        sound: 'default',
        categoryIdentifier: NOTIFICATION_CATEGORY_ID,
        data: { scheduleId, isSnooze: true },
      },
      trigger: {
        type: 'date',
        date: new Date(Date.now() + minutes * 60 * 1000),
      },
    });
  };

  useEffect(() => {
    Notifications.setNotificationCategoryAsync(NOTIFICATION_CATEGORY_ID, [
      {
        identifier: `${NOTIFICATION_ACTION_SNOOZE_PREFIX}10`,
        buttonTitle: 'Snooze 10m',
        options: { opensAppToForeground: true },
      },
      {
        identifier: `${NOTIFICATION_ACTION_SNOOZE_PREFIX}30`,
        buttonTitle: 'Snooze 30m',
        options: { opensAppToForeground: true },
      },
      {
        identifier: `${NOTIFICATION_ACTION_SNOOZE_PREFIX}60`,
        buttonTitle: 'Snooze 60m',
        options: { opensAppToForeground: true },
      },
      {
        identifier: NOTIFICATION_ACTION_SKIP,
        buttonTitle: 'Skip next',
        options: { opensAppToForeground: true },
      },
    ]).catch(() => {});

    const responseSub = Notifications.addNotificationResponseReceivedListener((response) => {
      const actionId = response.actionIdentifier;
      const data = response.notification.request.content;
      const scheduleId = (data.data as { scheduleId?: string } | undefined)?.scheduleId;

      if (!scheduleId) {
        return;
      }

      if (actionId.startsWith(NOTIFICATION_ACTION_SNOOZE_PREFIX)) {
        const minutes = Number(actionId.replace(NOTIFICATION_ACTION_SNOOZE_PREFIX, ''));
        if (Number.isFinite(minutes) && minutes > 0) {
          void scheduleSnooze(scheduleId, minutes);
          setInlineMessage(`Snoozed for ${minutes} minutes.`);
        }
        return;
      }

      if (actionId === NOTIFICATION_ACTION_SKIP) {
        void cancelNextScheduledNotification(scheduleId).then((didCancel) => {
          setInlineMessage(didCancel ? 'Skipped the next alert.' : 'No upcoming alert to skip.');
        });
      }
    });

    return () => {
      responseSub.remove();
    };
  }, []);

  const scheduleIfEligible = async (schedule: Schedule): Promise<ScheduleResult> => {
    const horizonHours = getScheduleType(schedule.type) === 'monthly' ? 24 * 90 : 24 * 7;
    await cancelScheduleNotifications(schedule.id);
    return scheduleNotificationsBatch([schedule], { quietHours, horizonHours });
  };

  const getEmptyScheduleMessage = (schedule: Schedule) => {
    const horizonDays = getScheduleType(schedule.type) === 'monthly' ? 90 : 7;
    if (quietHours.enabled) {
      return 'No alerts outside quiet hours. Adjust the time or quiet hours.';
    }
    return `No alerts in the next ${horizonDays} days. Adjust the schedule.`;
  };

  const updateQuietHours = (patch: Partial<QuietHours>) => {
    setQuietHours((current) => ({ ...current, ...patch }));
  };

  const completeOnboarding = () => {
    setIsOnboardingVisible(false);
    setHasSeenOnboarding(true);
    AsyncStorage.setItem(ONBOARDING_KEY, 'true').catch(() => {});
  };

  const enableNotificationsFromOnboarding = async () => {
    await new Promise<void>((resolve) => {
      InteractionManager.runAfterInteractions(() => resolve());
    });
    const granted = await requestAuthorization();
    if (granted) {
      setInlineMessage('Notifications enabled.');
    }
    completeOnboarding();
  };

  const setScheduleActive = (scheduleId: string, isActive: boolean) => {
    setSchedules((current) =>
      current.map((schedule) =>
        schedule.id === scheduleId ? { ...schedule, isActive } : schedule
      )
    );
  };

  const rescheduleSchedule = async (
    schedule: Schedule,
    options?: { silent?: boolean; preserveActive?: boolean }
  ) => {
    const silentSuccess = options?.silent ?? true;
    const preserveActive = options?.preserveActive ?? false;
    if (authorizationStatus !== 'authorized') {
      setInlineMessage('Notifications are off. You can enable them in Settings.');
      if (!preserveActive) {
        setScheduleActive(schedule.id, false);
      }
      return;
    }

    try {
      const result = await scheduleIfEligible(schedule);
      if (result.error) {
        setInlineMessage(`Notification setup failed: ${result.error}`);
        if (!preserveActive) {
          setScheduleActive(schedule.id, false);
        }
        return;
      }
      if (result.count === 0) {
        setInlineMessage(getEmptyScheduleMessage(schedule));
        if (!preserveActive) {
          setScheduleActive(schedule.id, false);
        }
        return;
      }
      if (!silentSuccess) {
        setInlineMessage(`Scheduled ${result.count} alerts.`);
      }
    } catch (error) {
      setInlineMessage(`Could not schedule notifications. ${formatError(error)}`);
      if (!preserveActive) {
        setScheduleActive(schedule.id, false);
      }
    }
  };

  const debouncedReschedule = (schedule: Schedule) => {
    clearRescheduleTimer(schedule.id);
    const timer = setTimeout(() => {
      rescheduleTimers.current.delete(schedule.id);
      void rescheduleSchedule(schedule, { silent: true, preserveActive: true });
    }, 300);
    rescheduleTimers.current.set(schedule.id, timer);
  };

  const onStartSchedule = async (scheduleId: string) => {
    const schedule = schedules.find((item) => item.id === scheduleId);
    if (!schedule) {
      return;
    }
    setScheduleActive(scheduleId, true);
    setInlineMessage('Setting notifications...');
    try {
      const granted =
        authorizationStatus === 'authorized' ? true : await requestAuthorization();
      if (!granted) {
        setInlineMessage('Notifications are off. You can enable them in Settings.');
        setScheduleActive(scheduleId, false);
        return;
      }
      clearRescheduleTimer(scheduleId);
      const result = await scheduleIfEligible({ ...schedule, isActive: true });
      if (result.error) {
        setInlineMessage(`Notification setup failed: ${result.error}`);
        setScheduleActive(scheduleId, false);
        return;
      }
      if (result.count === 0) {
        setInlineMessage(getEmptyScheduleMessage(schedule));
        setScheduleActive(scheduleId, false);
        return;
      }
      setInlineMessage(`Scheduled ${result.count} alerts.`);
    } catch (error) {
      setScheduleActive(scheduleId, false);
      setInlineMessage(`Could not schedule notifications. ${formatError(error)}`);
    }
  };

  const onStopSchedule = async (scheduleId: string) => {
    try {
      clearRescheduleTimer(scheduleId);
      await cancelScheduleNotifications(scheduleId);
      setScheduleActive(scheduleId, false);
      setInlineMessage('Notifications stopped for this notification.');
    } catch (error) {
      setInlineMessage(`Could not stop notifications. ${formatError(error)}`);
    }
  };

  const updateSchedule = (id: string, patch: Partial<Schedule>) => {
    if (draftSchedule?.id === id) {
      setDraftSchedule((current) => (current ? { ...current, ...patch } : current));
      return;
    }
    setSchedules((current) =>
      current.map((schedule) =>
        schedule.id === id ? { ...schedule, ...patch } : schedule
      )
    );
  };

  const stepInterval = (id: string, direction: 1 | -1) => {
    if (draftSchedule?.id === id) {
      setDraftSchedule((current) => {
        if (!current) {
          return current;
        }
        const next = current.intervalMinutes + direction * 5;
        const nextInterval = Math.min(MAX_INTERVAL, Math.max(MIN_INTERVAL, next));
        setIntervalDrafts((drafts) => ({ ...drafts, [id]: String(nextInterval) }));
        return { ...current, intervalMinutes: nextInterval };
      });
      return;
    }
    setSchedules((current) =>
      current.map((schedule) => {
        if (schedule.id !== id) {
          return schedule;
        }
        const next = schedule.intervalMinutes + direction * 5;
        const nextInterval = Math.min(MAX_INTERVAL, Math.max(MIN_INTERVAL, next));
        setIntervalDrafts((drafts) => ({ ...drafts, [id]: String(nextInterval) }));
        return {
          ...schedule,
          intervalMinutes: nextInterval,
        };
      })
    );
  };

  const updateIntervalDraft = (id: string, value: string) => {
    const sanitized = value.replace(/[^0-9]/g, '');
    setIntervalDrafts((current) => ({ ...current, [id]: sanitized }));
  };

  const commitIntervalDraft = (id: string) => {
    const draft = intervalDrafts[id];
    const schedule = draftSchedule?.id === id ? draftSchedule : schedules.find((item) => item.id === id);
    if (!schedule) {
      return;
    }
    const parsed = Number(draft);
    if (!Number.isFinite(parsed)) {
      setIntervalDrafts((current) => ({ ...current, [id]: String(schedule.intervalMinutes) }));
      return;
    }
    const next = Math.min(MAX_INTERVAL, Math.max(MIN_INTERVAL, Math.round(parsed)));
    setIntervalDrafts((current) => ({ ...current, [id]: String(next) }));
    updateSchedule(id, { intervalMinutes: next });
  };

  const stepDayOfMonth = (id: string, direction: 1 | -1) => {
    if (draftSchedule?.id === id) {
      setDraftSchedule((current) => {
        if (!current) {
          return current;
        }
        const currentDay = normalizeDayOfMonth(current.dayOfMonth);
        const nextDay = clampDayOfMonth(currentDay + direction);
        setDayOfMonthDrafts((drafts) => ({ ...drafts, [id]: String(nextDay) }));
        return {
          ...current,
          dayOfMonth: nextDay,
        };
      });
      return;
    }
    setSchedules((current) =>
      current.map((schedule) => {
        if (schedule.id !== id) {
          return schedule;
        }
        const currentDay = normalizeDayOfMonth(schedule.dayOfMonth);
        const nextDay = clampDayOfMonth(currentDay + direction);
        setDayOfMonthDrafts((drafts) => ({ ...drafts, [id]: String(nextDay) }));
        return {
          ...schedule,
          dayOfMonth: nextDay,
        };
      })
    );
  };

  const updateDayOfMonthDraft = (id: string, value: string) => {
    const sanitized = value.replace(/[^0-9]/g, '');
    setDayOfMonthDrafts((current) => ({ ...current, [id]: sanitized }));
  };

  const commitDayOfMonthDraft = (id: string) => {
    const draft = dayOfMonthDrafts[id];
    const schedule = draftSchedule?.id === id ? draftSchedule : schedules.find((item) => item.id === id);
    if (!schedule) {
      return;
    }
    const parsed = Number(draft);
    if (!Number.isFinite(parsed)) {
      const fallback = normalizeDayOfMonth(schedule.dayOfMonth);
      setDayOfMonthDrafts((current) => ({ ...current, [id]: String(fallback) }));
      return;
    }
    const nextDay = clampDayOfMonth(parsed);
    setDayOfMonthDrafts((current) => ({ ...current, [id]: String(nextDay) }));
    updateSchedule(id, { dayOfMonth: nextDay });
  };

  const toggleScheduleDay = (id: string, dayIndex: number) => {
    if (draftSchedule?.id === id) {
      setDraftSchedule((current) => {
        if (!current) {
          return current;
        }
        const nextDays = [...normalizeDaysOfWeek(current.daysOfWeek)];
        nextDays[dayIndex] = !nextDays[dayIndex];
        return { ...current, daysOfWeek: nextDays };
      });
      return;
    }
    setSchedules((current) =>
      current.map((schedule) => {
        if (schedule.id !== id) {
          return schedule;
        }
        const nextDays = [...normalizeDaysOfWeek(schedule.daysOfWeek)];
        nextDays[dayIndex] = !nextDays[dayIndex];
        return { ...schedule, daysOfWeek: nextDays };
      })
    );
  };

  const clearDraftInputs = (id: string) => {
    setIntervalDrafts((current) => {
      const { [id]: _, ...rest } = current;
      return rest;
    });
    setDayOfMonthDrafts((current) => {
      const { [id]: _, ...rest } = current;
      return rest;
    });
  };

  const presentDetailSheet = () => {
    setIsDetailSheetVisible(true);
    detailScrollY.value = 0;
    detailSheetOffset.value = windowHeight;
    detailSheetOffset.value = withTiming(0, { duration: 260 });
  };

  const finalizeDetailClose = (
    action: 'discard' | 'save',
    mode: 'add' | 'edit' | null,
    draftId?: string
  ) => {
    if (action === 'discard' && mode === 'add' && draftId) {
      clearDraftInputs(draftId);
    }
    setDraftSchedule(null);
    setIsDetailSheetVisible(false);
    setDetailScheduleId(null);
    setDetailMode(null);
  };

  const closeDetailSheet = (action: 'discard' | 'save') => {
    const mode = detailMode;
    const draftId = draftSchedule?.id;
    detailSheetOffset.value = withTiming(windowHeight, { duration: 220 }, (finished) => {
      if (finished) {
        runOnJS(finalizeDetailClose)(action, mode, draftId);
      }
    });
  };

  const addSchedule = () => {
    setActivePicker(null);
    setIsListEditing(false);
    const newSchedule = createSchedule('Reminder', 'withinDay');
    setDraftSchedule(newSchedule);
    setIntervalDrafts((current) => ({
      ...current,
      [newSchedule.id]: String(newSchedule.intervalMinutes),
    }));
    if (newSchedule.dayOfMonth) {
      setDayOfMonthDrafts((current) => ({
        ...current,
        [newSchedule.id]: String(newSchedule.dayOfMonth),
      }));
    }
    setDetailScheduleId(newSchedule.id);
    setDetailMode('add');
    presentDetailSheet();
  };

  const openScheduleDetail = (scheduleId: string) => {
    setIsListEditing(false);
    const schedule = schedules.find((item) => item.id === scheduleId);
    if (!schedule) {
      return;
    }
    setDraftSchedule({
      ...schedule,
      daysOfWeek: normalizeDaysOfWeek(schedule.daysOfWeek),
    });
    setIntervalDrafts((current) => ({
      ...current,
      [schedule.id]: String(schedule.intervalMinutes),
    }));
    if (schedule.dayOfMonth) {
      setDayOfMonthDrafts((current) => ({
        ...current,
        [schedule.id]: String(schedule.dayOfMonth),
      }));
    }
    setDetailScheduleId(scheduleId);
    setDetailMode('edit');
    presentDetailSheet();
  };

  const saveScheduleDetail = () => {
    if (draftSchedule) {
      if (detailMode === 'add') {
        setSchedules((current) => [...current, draftSchedule]);
      } else {
        setSchedules((current) =>
          current.map((schedule) =>
            schedule.id === draftSchedule.id ? draftSchedule : schedule
          )
        );
      }
    }
    closeDetailSheet('save');
  };

  const detailScrollHandler = useAnimatedScrollHandler({
    onScroll: (event) => {
      detailScrollY.value = event.contentOffset.y;
    },
  });

  const detailSheetAnimatedStyle = useAnimatedStyle(
    () => ({
      transform: [{ translateY: detailSheetOffset.value }],
    }),
    []
  );

  const detailBackdropAnimatedStyle = useAnimatedStyle(
    () => ({
      opacity: 1 - Math.min(detailSheetOffset.value / windowHeight, 1),
    }),
    [windowHeight]
  );

  const detailPanGesture = useMemo(
    () =>
      Gesture.Pan()
        .onUpdate((event) => {
          if (detailScrollY.value > 0) {
            return;
          }
          if (event.translationY > 0) {
            detailSheetOffset.value = event.translationY;
          } else {
            detailSheetOffset.value = 0;
          }
        })
        .onEnd((event) => {
          if (detailScrollY.value > 0) {
            detailSheetOffset.value = withSpring(0, { damping: 28, stiffness: 280 });
            return;
          }
          const shouldClose = event.translationY > 120 || event.velocityY > 1200;
          if (shouldClose) {
            runOnJS(closeDetailSheet)('discard');
          } else {
            detailSheetOffset.value = withSpring(0, { damping: 28, stiffness: 280 });
          }
        }),
    [closeDetailSheet, detailScrollY, detailSheetOffset]
  );

  const removeSchedule = async (id: string) => {
    clearRescheduleTimer(id);
    try {
      await cancelScheduleNotifications(id);
    } catch {
      // Ignore cancellation errors during removal.
    }
    setActivePicker((current) => (current?.scheduleId === id ? null : current));
    setSchedules((current) => current.filter((schedule) => schedule.id !== id));
    setIntervalDrafts((current) => {
      const { [id]: _, ...rest } = current;
      return rest;
    });
    setDayOfMonthDrafts((current) => {
      const { [id]: _, ...rest } = current;
      return rest;
    });
  };

  const activeSchedule = useMemo(() => {
    if (!activePicker || activePicker.scheduleId === 'quiet') {
      return null;
    }
    if (draftSchedule && activePicker.scheduleId === draftSchedule.id) {
      return draftSchedule;
    }
    return schedules.find((schedule) => schedule.id === activePicker.scheduleId) ?? null;
  }, [activePicker, draftSchedule, schedules]);

  const detailSchedule = useMemo(() => {
    if (draftSchedule) {
      return draftSchedule;
    }
    if (!detailScheduleId) {
      return null;
    }
    return schedules.find((schedule) => schedule.id === detailScheduleId) ?? null;
  }, [detailScheduleId, draftSchedule, schedules]);

  const activePickerDate = useMemo(() => {
    if (!activePicker) {
      return new Date();
    }
    if (activePicker.scheduleId === 'quiet') {
      const minutes =
        activePicker.kind === 'start'
          ? quietHours.startMinutesFromMidnight
          : quietHours.endMinutesFromMidnight;
      return minutesToDate(minutes);
    }
    if (!activeSchedule) {
      return new Date();
    }
    const minutes =
      activePicker.kind === 'start'
        ? activeSchedule.startMinutesFromMidnight
        : activeSchedule.endMinutesFromMidnight;
    return minutesToDate(minutes);
  }, [activePicker, activeSchedule, quietHours]);

  const fadeHeight = Math.max(45, Math.round(windowHeight * 0.075));
  const hasSchedules = schedules.length > 0;
  const scheduleIndexById = new Map(schedules.map((schedule, index) => [schedule.id, index]));
  const scheduleSections = [
    {
      key: 'withinDay',
      label: 'Intraday',
      items: schedules.filter((schedule) => getScheduleType(schedule.type) === 'withinDay'),
    },
    {
      key: 'daily',
      label: 'Daily',
      items: schedules.filter((schedule) => getScheduleType(schedule.type) === 'daily'),
    },
    {
      key: 'weekly',
      label: 'Weekly',
      items: schedules.filter((schedule) => getScheduleType(schedule.type) === 'weekly'),
    },
    {
      key: 'monthly',
      label: 'Monthly',
      items: schedules.filter((schedule) => getScheduleType(schedule.type) === 'monthly'),
    },
  ];
  const scrollFlexGrow = Platform.OS === 'ios' ? 1 : hasSchedules ? 0 : 1;
  const fadeColors = [
    withAlpha(colors.background, 1),
    withAlpha(colors.background, 0.55),
    withAlpha(colors.background, 0),
  ];
  const bottomFadeColors = [
    withAlpha(colors.background, 0),
    withAlpha(colors.background, 0.55),
    withAlpha(colors.background, 1),
  ];
  const fadeLocations = [0, 0.5, 1];
  const glassBlurIntensity = colorScheme === 'dark' ? 20 : 28;
  const glassCard = withAlpha(colors.card, colorScheme === 'dark' ? 0.5 : 0.78);
  const glassSheet = withAlpha(colors.sheet, colorScheme === 'dark' ? 0.55 : 0.8);
  const glassBorder = withAlpha(colors.border, colorScheme === 'dark' ? 0.7 : 0.6);
  const headerButtonBorder = withAlpha(colors.shadow, colorScheme === 'dark' ? 0.6 : 0.35);
  const glassHighlightStrong = withAlpha('#FFFFFF', colorScheme === 'dark' ? 0.12 : 0.28);
  const glassHighlightSoft = withAlpha('#FFFFFF', colorScheme === 'dark' ? 0.04 : 0.12);
  const glassHighlightFade = withAlpha('#FFFFFF', 0);
  const backgroundGradient = [colors.card, colors.inputBackground, colors.background];
  const backgroundGradientLocations = [0, 0.5, 1];
  const contentBottomPadding = keyboardHeight > 0 ? 0 : TAB_BAR_HEIGHT + insets.bottom + 4;
  const detailScheduleType = detailSchedule ? getScheduleType(detailSchedule.type) : 'daily';
  const detailScheduleDays = detailSchedule
    ? normalizeDaysOfWeek(detailSchedule.daysOfWeek)
    : DEFAULT_DAYS;
  const detailIntervalValue = detailSchedule
    ? intervalDrafts[detailSchedule.id] ?? String(detailSchedule.intervalMinutes)
    : '';
  const detailDayOfMonthValue = detailSchedule
    ? dayOfMonthDrafts[detailSchedule.id] ?? String(normalizeDayOfMonth(detailSchedule.dayOfMonth))
    : '';
  const detailTypeOption = SCHEDULE_TYPE_OPTIONS.find(
    (option) => option.value === detailScheduleType
  );
  const detailSheetHeight = Math.round(
    Math.min(windowHeight * 0.82, windowHeight - insets.top - 24) * 0.92
  );
  const scrollPaddingTop = hasSchedules ? 18 : 0;
  const scrollPaddingBottom = hasSchedules ? contentBottomPadding : 0;
  const scrollOverflow = scrollContentHeight - scrollViewHeight;
  const shouldSnapScroll =
    scrollViewHeight > 0 &&
    scrollContentHeight > 0 &&
    scrollOverflow <= scrollPaddingTop + scrollPaddingBottom;
  const iosSnapOffsets = Platform.OS === 'ios' && shouldSnapScroll ? [0] : undefined;
  const iosSnapAlignment = Platform.OS === 'ios' && shouldSnapScroll ? 'start' : undefined;

  const updateScheduleType = (schedule: Schedule, nextType: ScheduleType) => {
    if (schedule.type === nextType) {
      return;
    }
    const currentDays = normalizeDaysOfWeek(schedule.daysOfWeek);
    const hasSelectedDays = currentDays.some(Boolean);
    const nextDays =
      nextType === 'weekly'
        ? hasSelectedDays
          ? currentDays
          : getWeeklyDefaultDays()
        : DEFAULT_DAYS.slice();
    const nextDayOfMonth =
      nextType === 'monthly' ? normalizeDayOfMonth(schedule.dayOfMonth) : undefined;
    const nextEndMinutes =
      nextType === 'withinDay'
        ? schedule.type === 'withinDay'
          ? schedule.endMinutesFromMidnight
          : Math.min(schedule.startMinutesFromMidnight + 8 * 60, 23 * 60 + 59)
        : schedule.startMinutesFromMidnight;
    updateSchedule(schedule.id, {
      type: nextType,
      daysOfWeek: nextDays,
      dayOfMonth: nextDayOfMonth,
      endMinutesFromMidnight: nextEndMinutes,
    });
  };
  const fadeOpacity = scrollY.interpolate({
    inputRange: [12, 36],
    outputRange: [0, 1],
    extrapolate: 'clamp',
  });
  const settingsFadeOpacity = settingsScrollY.interpolate({
    inputRange: [12, 36],
    outputRange: [0, 1],
    extrapolate: 'clamp',
  });


  const onPickerChange = (_: DateTimePickerEvent, selected?: Date) => {
    if (!selected || !activePicker) {
      return;
    }
    const minutes = dateToMinutes(selected);
    if (activePicker.scheduleId === 'quiet') {
      if (activePicker.kind === 'start') {
        updateQuietHours({ startMinutesFromMidnight: minutes });
      } else {
        updateQuietHours({ endMinutesFromMidnight: minutes });
      }
      return;
    }
    if (activePicker.kind === 'start') {
      const activeType = activeSchedule ? getScheduleType(activeSchedule.type) : 'daily';
      if (activeType === 'withinDay') {
        updateSchedule(activePicker.scheduleId, { startMinutesFromMidnight: minutes });
      } else {
        updateSchedule(activePicker.scheduleId, {
          startMinutesFromMidnight: minutes,
          endMinutesFromMidnight: minutes,
        });
      }
    } else {
      updateSchedule(activePicker.scheduleId, { endMinutesFromMidnight: minutes });
    }
  };

  const onToggleDarkMode = (value: boolean) => {
    setDarkModeDraft(value);
    if (darkModeTimerRef.current) {
      clearTimeout(darkModeTimerRef.current);
      darkModeTimerRef.current = null;
    }
    darkModeTimerRef.current = setTimeout(() => {
      setDarkMode(value);
    }, 200);
  };

  return (
    <SafeAreaView edges={['top']} style={styles.safeArea}>
      <LinearGradient
        colors={backgroundGradient}
        locations={backgroundGradientLocations}
        start={{ x: 0, y: 0 }}
        end={{ x: 0, y: 1 }}
        style={StyleSheet.absoluteFillObject}
        pointerEvents="none"
      />
      <StatusBar
        style={colorScheme === 'dark' ? 'light' : 'dark'}
        backgroundColor="transparent"
        translucent
      />
      {activeTab === 'home' ? (
        <View style={styles.flex}>
        <View
          style={[
            styles.headerBar,
            { borderColor: glassBorder },
          ]}
          onLayout={(event) => setHeaderHeight(event.nativeEvent.layout.height)}
        >
          <Text style={[styles.title, { color: colors.textPrimary }]}>Reminders</Text>
          <View style={styles.headerActions}>
            <Pressable
              style={[
                styles.headerActionButton,
                { borderColor: headerButtonBorder, backgroundColor: colors.inputBackground },
              ]}
              onPress={() => setIsListEditing((current) => !current)}
              accessibilityRole="button"
              accessibilityLabel={isListEditing ? 'Done' : 'Edit reminders'}
            >
              <Text style={[styles.headerActionText, { color: colors.accent }]}>
                {isListEditing ? 'Done' : 'Edit'}
              </Text>
            </Pressable>
            <Pressable
              style={[
                styles.addButton,
                { backgroundColor: colors.inputBackground, borderColor: headerButtonBorder },
              ]}
              onPress={addSchedule}
              accessibilityRole="button"
              accessibilityLabel="Add reminder"
              hitSlop={8}
            >
              <MaterialIcons name="add" size={22} color={colors.accent} />
            </Pressable>
          </View>
        </View>
        <Animated.ScrollView
          style={styles.scroll}
          contentContainerStyle={[
            styles.container,
            {
              paddingTop: hasSchedules ? 18 : 0,
              paddingBottom: hasSchedules ? contentBottomPadding : 0,
              minHeight: keyboardHeight > 0 ? 0 : '100%',
              flexGrow: scrollFlexGrow,
              justifyContent: hasSchedules ? 'flex-start' : 'center',
            },
          ]}
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="interactive"
          contentInsetAdjustmentBehavior="always"
          automaticallyAdjustKeyboardInsets
          alwaysBounceVertical
          snapToOffsets={iosSnapOffsets}
          snapToAlignment={iosSnapAlignment}
          showsVerticalScrollIndicator={false}
          scrollEventThrottle={16}
          onScroll={Animated.event(
            [{ nativeEvent: { contentOffset: { y: scrollY } } }],
            { useNativeDriver: true }
          )}
          onLayout={(event) => setScrollViewHeight(event.nativeEvent.layout.height)}
          onContentSizeChange={(_, height) => setScrollContentHeight(height)}
        >
          {!hasSchedules ? (
            <View style={styles.emptyState}>
              <Text style={[styles.emptyStateTitle, { color: colors.textPrimary }]}>
                No reminders yet
              </Text>
              <Pressable
                style={[styles.emptyStateButton, { backgroundColor: colors.accent }]}
                onPress={addSchedule}
                accessibilityRole="button"
                accessibilityLabel="Create a reminder"
              >
                <Text style={styles.emptyStateButtonLabel}>Create a reminder</Text>
              </Pressable>
            </View>
          ) : null}

          {hasSchedules ? (
            <View style={styles.alarmSections}>
              {scheduleSections
                .filter((section) => section.items.length > 0)
                .map((section) => (
                  <View key={section.key} style={styles.alarmSection}>
                    <Text style={[styles.alarmSectionTitle, { color: colors.textSecondary }]}>
                      {section.label}
                    </Text>
                    <View
                      style={[
                        styles.alarmList,
                        {
                          backgroundColor: glassCard,
                          borderColor: glassBorder,
                          shadowColor: colors.shadow,
                        },
                      ]}
                    >
                      <BlurView
                        intensity={glassBlurIntensity}
                        tint={colorScheme === 'dark' ? 'dark' : 'light'}
                        style={[StyleSheet.absoluteFillObject, { borderRadius: 22 }]}
                        pointerEvents="none"
                      />
                      {section.items.map((schedule, sectionIndex) => {
                        const scheduleType = getScheduleType(schedule.type);
                        const startLabel = formatTime(schedule.startMinutesFromMidnight);
                        const daysOfWeek = normalizeDaysOfWeek(schedule.daysOfWeek);
                        const dayOfMonth = normalizeDayOfMonth(schedule.dayOfMonth);
                        const daysSummary = formatDaysSummary(daysOfWeek);
                        const hasSomeDays = daysOfWeek.some(Boolean);
                        const isFullWeek = daysOfWeek.every(Boolean);
                        const timeSummary =
                          scheduleType === 'withinDay'
                            ? formatTimeRangeSummary(
                                schedule.startMinutesFromMidnight,
                                schedule.endMinutesFromMidnight
                              )
                            : startLabel;
                        const summaryLines =
                          scheduleType === 'withinDay'
                            ? hasSomeDays && !isFullWeek
                              ? [
                                  daysSummary,
                                  `${timeSummary} • Every ${schedule.intervalMinutes} min`,
                                ]
                              : [
                                  `${daysSummary} • ${timeSummary} • Every ${schedule.intervalMinutes} min`,
                                ]
                            : scheduleType === 'daily'
                              ? ['Daily']
                              : scheduleType === 'weekly'
                                ? [`Weekly • ${formatWeeklyDaysSummary(daysOfWeek)}`]
                                : [`Monthly • ${formatDayOfMonthLabel(dayOfMonth)}`];
                        const displayTime = scheduleType === 'withinDay' ? timeSummary : startLabel;
                        const scheduleIndex = scheduleIndexById.get(schedule.id) ?? sectionIndex;
                        const scheduleDisplayName =
                          schedule.name?.trim() || getDefaultNotificationName(scheduleIndex);
                        const isLast = sectionIndex === section.items.length - 1;
                        return (
                          <View
                            key={schedule.id}
                            style={[
                              styles.alarmRow,
                              !isLast && { borderBottomColor: colors.border, borderBottomWidth: 1 },
                            ]}
                          >
                            {isListEditing ? (
                              <Pressable
                                style={styles.alarmDelete}
                                onPress={() => void removeSchedule(schedule.id)}
                                accessibilityRole="button"
                                accessibilityLabel={`Delete ${scheduleDisplayName}`}
                              >
                                <View
                                  style={[
                                    styles.alarmDeleteBadge,
                                    { backgroundColor: colors.remove },
                                  ]}
                                >
                                  <Text style={styles.alarmDeleteText}>-</Text>
                                </View>
                              </Pressable>
                            ) : null}
                            <Pressable
                              style={styles.alarmRowMain}
                              onPress={() => openScheduleDetail(schedule.id)}
                              accessibilityRole="button"
                              accessibilityLabel={`Edit ${scheduleDisplayName}`}
                            >
                              <Text style={[styles.alarmTime, { color: colors.textPrimary }]}>
                                {scheduleDisplayName}
                              </Text>
                              <Text style={[styles.alarmLabel, { color: colors.textSecondary }]}>
                                {displayTime}
                              </Text>
                              {summaryLines.length === 1 ? (
                                <Text style={[styles.alarmSubtext, { color: colors.textMuted }]}>
                                  {summaryLines[0]}
                                </Text>
                              ) : (
                                <View style={styles.alarmSubtextGroup}>
                                  {summaryLines.map((line, lineIndex) => (
                                    <Text
                                      key={`${schedule.id}-summary-${lineIndex}`}
                                      style={[styles.alarmSubtext, { color: colors.textMuted }]}
                                    >
                                      {line}
                                    </Text>
                                  ))}
                                </View>
                              )}
                            </Pressable>
                            {!isListEditing ? (
                              <View style={styles.alarmToggle}>
                                <Switch
                                  value={schedule.isActive}
                                  onValueChange={(value) =>
                                    value
                                      ? void onStartSchedule(schedule.id)
                                      : void onStopSchedule(schedule.id)
                                  }
                                  trackColor={{ false: colors.border, true: colors.accent }}
                                  ios_backgroundColor={colors.border}
                                />
                              </View>
                            ) : null}
                          </View>
                        );
                      })}
                    </View>
                  </View>
                ))}
            </View>
          ) : null}

        </Animated.ScrollView>
      <Animated.View
        pointerEvents="none"
        style={[
          styles.topFade,
          {
            top: headerHeight,
            height: fadeHeight,
            opacity: fadeOpacity,
          },
        ]}
      >
          <LinearGradient
            colors={fadeColors}
            locations={fadeLocations}
            start={{ x: 0, y: 0 }}
            end={{ x: 0, y: 1 }}
            style={StyleSheet.absoluteFillObject}
          />
        </Animated.View>
        <View
          pointerEvents="none"
          style={[
            styles.bottomFade,
            {
              bottom: 0,
              height: fadeHeight,
            },
          ]}
        >
          <LinearGradient
            colors={bottomFadeColors}
            locations={fadeLocations}
            start={{ x: 0, y: 0 }}
            end={{ x: 0, y: 1 }}
            style={StyleSheet.absoluteFillObject}
          />
        </View>
      </View>
      ) : (
        <View style={styles.flex}>
          <View
            style={[styles.headerBar, { borderColor: glassBorder }]}
            onLayout={(event) => setSettingsHeaderHeight(event.nativeEvent.layout.height)}
          >
            <Text style={[styles.title, { color: colors.textPrimary }]}>Settings</Text>
          </View>
          <Animated.ScrollView
            style={styles.scroll}
            contentContainerStyle={styles.settingsContainer}
            contentInsetAdjustmentBehavior="always"
            keyboardShouldPersistTaps="handled"
            showsVerticalScrollIndicator={false}
            scrollEventThrottle={16}
            onScroll={Animated.event(
              [{ nativeEvent: { contentOffset: { y: settingsScrollY } } }],
              { useNativeDriver: true }
            )}
          >
            <View
              style={[
                styles.card,
                {
                  backgroundColor: glassCard,
                  shadowColor: colors.shadow,
                  borderColor: glassBorder,
                },
              ]}
            >
              <BlurView
                intensity={glassBlurIntensity}
                tint={colorScheme === 'dark' ? 'dark' : 'light'}
                style={[StyleSheet.absoluteFillObject, { borderRadius: 20 }]}
                pointerEvents="none"
              />
              <View style={styles.settingsRow}>
                <View style={styles.settingsText}>
                  <Text style={[styles.settingsLabel, { color: colors.textPrimary }]}>
                    Dark mode
                  </Text>
                  <Text style={[styles.settingsHelper, { color: colors.textSecondary }]}>
                    Use the dark color theme.
                  </Text>
                </View>
                <Switch
                  value={darkModeDraft}
                  onValueChange={onToggleDarkMode}
                  trackColor={{ false: colors.border, true: colors.accent }}
                  ios_backgroundColor={colors.border}
                />
              </View>
            </View>
            <View
              style={[
                styles.card,
                {
                  backgroundColor: glassCard,
                  shadowColor: colors.shadow,
                  borderColor: glassBorder,
                },
              ]}
            >
              <BlurView
                intensity={glassBlurIntensity}
                tint={colorScheme === 'dark' ? 'dark' : 'light'}
                style={[StyleSheet.absoluteFillObject, { borderRadius: 20 }]}
                pointerEvents="none"
              />
              <View style={styles.settingsRow}>
                <View style={styles.settingsText}>
                  <Text style={[styles.settingsLabel, { color: colors.textPrimary }]}>
                    Quiet hours
                  </Text>
                  <Text style={[styles.settingsHelper, { color: colors.textSecondary }]}>
                    Mute alerts during the hours you choose.
                  </Text>
                </View>
                <Switch
                  value={quietHours.enabled}
                  onValueChange={(value) => updateQuietHours({ enabled: value })}
                  trackColor={{ false: colors.border, true: colors.accent }}
                  ios_backgroundColor={colors.border}
                />
              </View>
              <View style={styles.timeRowGroup}>
                <Pressable
                  style={[
                    styles.timeRow,
                    { backgroundColor: colors.inputBackground, borderColor: colors.border },
                  ]}
                  onPress={() => setActivePicker({ scheduleId: 'quiet', kind: 'start' })}
                >
                  <Text style={[styles.timeLabel, { color: colors.label }]}>Start</Text>
                  <Text style={[styles.timeValue, { color: colors.textPrimary }]}>
                    {formatTime(quietHours.startMinutesFromMidnight)}
                  </Text>
                </Pressable>
                <Pressable
                  style={[
                    styles.timeRow,
                    { backgroundColor: colors.inputBackground, borderColor: colors.border },
                  ]}
                  onPress={() => setActivePicker({ scheduleId: 'quiet', kind: 'end' })}
                >
                  <Text style={[styles.timeLabel, { color: colors.label }]}>End</Text>
                  <Text style={[styles.timeValue, { color: colors.textPrimary }]}>
                    {formatTime(quietHours.endMinutesFromMidnight)}
                  </Text>
                </Pressable>
              </View>
              <Text style={[styles.helperText, { color: colors.textMuted }]}>
                Alerts that fall inside this window will be skipped.
              </Text>
            </View>
          </Animated.ScrollView>
          <Animated.View
            pointerEvents="none"
            style={[
              styles.topFade,
              {
                top: settingsHeaderHeight,
                height: fadeHeight,
                opacity: settingsFadeOpacity,
              },
            ]}
          >
            <LinearGradient
              colors={fadeColors}
              locations={fadeLocations}
              start={{ x: 0, y: 0 }}
              end={{ x: 0, y: 1 }}
              style={StyleSheet.absoluteFillObject}
            />
          </Animated.View>
        </View>
      )}

      <View
        style={[
          styles.tabBar,
          {
            height: TAB_BAR_HEIGHT + insets.bottom,
            paddingBottom: insets.bottom,
          },
        ]}
      >
        <View
          style={[
            styles.tabPill,
            {
              borderColor: colors.accent,
              shadowColor: colors.shadow,
              backgroundColor: glassCard,
            },
          ]}
        >
          <BlurView
            intensity={28}
            tint={colorScheme === 'dark' ? 'dark' : 'light'}
            style={StyleSheet.absoluteFillObject}
          />
          <LinearGradient
            colors={[glassHighlightStrong, glassHighlightSoft, glassHighlightFade]}
            locations={[0, 0.5, 1]}
            start={{ x: 0, y: 0 }}
            end={{ x: 0, y: 1 }}
            style={StyleSheet.absoluteFillObject}
            pointerEvents="none"
          />
          <View style={styles.tabPillContent}>
            <Pressable
              onPress={() => setActiveTab('home')}
              style={styles.tabButton}
              accessibilityRole="button"
              accessibilityState={{ selected: activeTab === 'home' }}
            >
              <MaterialIcons
                name="restore"
                size={25}
                color={activeTab === 'home' ? colors.accent : colors.textSecondary}
                style={styles.tabIcon}
              />
              <Text
                style={[
                  styles.tabLabel,
                  { color: activeTab === 'home' ? colors.accent : colors.textSecondary },
                ]}
              >
                Reminders
              </Text>
            </Pressable>
            <Pressable
              onPress={() => setActiveTab('settings')}
              style={styles.tabButton}
              accessibilityRole="button"
              accessibilityState={{ selected: activeTab === 'settings' }}
            >
              <MaterialCommunityIcons
                name="cog-outline"
                size={25}
                color={activeTab === 'settings' ? colors.accent : colors.textSecondary}
                style={styles.tabIcon}
              />
              <Text
                style={[
                  styles.tabLabel,
                  { color: activeTab === 'settings' ? colors.accent : colors.textSecondary },
                ]}
              >
                Settings
              </Text>
            </Pressable>
          </View>
        </View>
      </View>

      {isDetailSheetVisible && detailSchedule ? (
        <View style={styles.detailBackdrop}>
          <Reanimated.View
            pointerEvents="none"
            style={[
              styles.detailBackdropFill,
              { backgroundColor: colors.sheetBackdrop },
              detailBackdropAnimatedStyle,
            ]}
          />
          <Pressable
            style={StyleSheet.absoluteFillObject}
            onPress={() => closeDetailSheet('discard')}
          />
          <GestureDetector gesture={detailPanGesture}>
            <Reanimated.View
              style={[
                styles.detailSheet,
                {
                  backgroundColor: glassSheet,
                  height: detailSheetHeight,
                  borderColor: glassBorder,
                  paddingBottom: 24 + insets.bottom,
                },
                detailSheetAnimatedStyle,
              ]}
            >
              <BlurView
                intensity={glassBlurIntensity}
                tint={colorScheme === 'dark' ? 'dark' : 'light'}
                style={[StyleSheet.absoluteFillObject, { borderRadius: 26 }]}
                pointerEvents="none"
              />
              <LinearGradient
                colors={[glassHighlightStrong, glassHighlightSoft, glassHighlightFade]}
                locations={[0, 0.5, 1]}
                start={{ x: 0, y: 0 }}
                end={{ x: 0, y: 1 }}
                style={[StyleSheet.absoluteFillObject, { borderRadius: 26 }]}
                pointerEvents="none"
              />
              <View style={styles.detailHeader}>
                <Pressable
                  onPress={() => closeDetailSheet('discard')}
                  hitSlop={8}
                  accessibilityRole="button"
                  accessibilityLabel="Cancel reminder changes"
                  style={[
                    styles.detailHeaderButton,
                    { backgroundColor: colors.inputBackground, borderColor: colors.border },
                  ]}
                >
                  <MaterialIcons name="close" size={20} color={colors.textPrimary} />
                </Pressable>
                <Text style={[styles.detailTitle, { color: colors.textPrimary }]}>
                  {detailMode === 'add' ? 'Add Reminder' : 'Edit Reminder'}
                </Text>
                <Pressable
                  onPress={saveScheduleDetail}
                  hitSlop={8}
                  accessibilityRole="button"
                  accessibilityLabel="Save reminder"
                  style={[
                    styles.detailHeaderButton,
                    { backgroundColor: colors.accent, borderColor: colors.accent },
                  ]}
                >
                  <MaterialIcons name="check" size={20} color="#FFFFFF" />
                </Pressable>
              </View>
              <Reanimated.ScrollView
                contentContainerStyle={styles.detailContent}
                showsVerticalScrollIndicator={false}
                keyboardShouldPersistTaps="handled"
                keyboardDismissMode="interactive"
                automaticallyAdjustKeyboardInsets
                contentInsetAdjustmentBehavior="always"
                style={styles.detailScroll}
                scrollEventThrottle={16}
                onScroll={detailScrollHandler}
              >
              <View style={styles.detailPickerGroup}>
                <Text style={[styles.detailSectionTitle, { color: colors.textSecondary }]}>
                  Time
                </Text>
                <View
                  style={[
                    styles.detailTimeGroup,
                    { backgroundColor: glassCard, borderColor: glassBorder },
                  ]}
                >
                  <Pressable
                    style={styles.timeRow}
                    onPress={() =>
                      setActivePicker({ scheduleId: detailSchedule.id, kind: 'start' })
                    }
                    accessibilityRole="button"
                    accessibilityLabel="Choose start time"
                  >
                    <Text style={[styles.timeLabel, { color: colors.textPrimary }]}>
                      {detailScheduleType === 'withinDay' ? 'Start' : 'Time'}
                    </Text>
                    <Text style={[styles.timeValue, { color: colors.textPrimary }]}>
                      {formatTime(detailSchedule.startMinutesFromMidnight)}
                    </Text>
                  </Pressable>
                  {detailScheduleType === 'withinDay' ? (
                    <>
                      <View
                        style={[styles.detailTimeDivider, { backgroundColor: colors.border }]}
                      />
                      <Pressable
                        style={styles.timeRow}
                        onPress={() =>
                          setActivePicker({ scheduleId: detailSchedule.id, kind: 'end' })
                        }
                        accessibilityRole="button"
                        accessibilityLabel="Choose end time"
                      >
                        <Text style={[styles.timeLabel, { color: colors.textPrimary }]}>End</Text>
                        <Text style={[styles.timeValue, { color: colors.textPrimary }]}>
                          {formatTime(detailSchedule.endMinutesFromMidnight)}
                        </Text>
                      </Pressable>
                    </>
                  ) : null}
                </View>
              </View>

              <View
                style={[
                  styles.detailSection,
                  { backgroundColor: glassCard, borderColor: glassBorder },
                ]}
              >
                <View style={styles.detailRow}>
                  <Text style={[styles.detailRowLabel, { color: colors.textPrimary }]}>Label</Text>
                  <TextInput
                    value={detailSchedule.name ?? ''}
                    onChangeText={(value) => updateSchedule(detailSchedule.id, { name: value })}
                    selectTextOnFocus
                    placeholder="Reminder"
                    placeholderTextColor={colors.placeholder}
                    style={[styles.detailRowInput, { color: colors.textPrimary }]}
                  />
                </View>
                <View style={[styles.detailDivider, { backgroundColor: colors.border }]} />
                <View style={styles.detailRow}>
                  <Text style={[styles.detailRowLabel, { color: colors.textPrimary }]}>
                    Message
                  </Text>
                  <TextInput
                    value={detailSchedule.message ?? ''}
                    onChangeText={(value) => updateSchedule(detailSchedule.id, { message: value })}
                    selectTextOnFocus
                    placeholder="Don't forget!"
                    placeholderTextColor={colors.placeholder}
                    style={[styles.detailRowInput, { color: colors.textPrimary }]}
                  />
                </View>
              </View>

              <View
                style={[
                  styles.detailSection,
                  { backgroundColor: glassCard, borderColor: glassBorder },
                ]}
              >
                <Text style={[styles.detailSectionTitle, { color: colors.textSecondary }]}>
                  Schedule
                </Text>
                <View style={styles.typeOptions}>
                  {SCHEDULE_TYPE_OPTIONS.map((option) => {
                    const isSelected = detailScheduleType === option.value;
                    return (
                      <Pressable
                        key={option.value}
                        style={[
                          styles.typeOption,
                          {
                            borderColor: isSelected ? colors.accent : colors.border,
                            backgroundColor: isSelected
                              ? withAlpha(colors.accent, colorScheme === 'dark' ? 0.2 : 0.12)
                              : 'transparent',
                          },
                        ]}
                        onPress={() => updateScheduleType(detailSchedule, option.value)}
                      >
                        <Text
                          style={[
                            styles.typeOptionText,
                            { color: isSelected ? colors.accent : colors.textSecondary },
                          ]}
                        >
                          {option.label}
                        </Text>
                      </Pressable>
                    );
                  })}
                </View>
                {detailTypeOption ? (
                  <Text style={[styles.typeHelper, { color: colors.textMuted }]}>
                    {detailTypeOption.helper}
                  </Text>
                ) : null}

                {detailScheduleType === 'withinDay' ? (
                  <View
                    style={[
                      styles.intervalRow,
                      { backgroundColor: colors.inputBackground, borderColor: colors.border },
                    ]}
                  >
                    <Text style={[styles.detailRowLabel, { color: colors.textPrimary }]}>Every</Text>
                    <View style={styles.intervalInputGroup}>
                      <Pressable
                        style={[styles.stepperButton, { backgroundColor: colors.accent }]}
                        onPress={() => stepInterval(detailSchedule.id, -1)}
                        accessibilityRole="button"
                        accessibilityLabel="Decrease interval"
                      >
                        <Text style={styles.stepperLabel}>-</Text>
                      </Pressable>
                      <TextInput
                        value={detailIntervalValue}
                        onChangeText={(value) => updateIntervalDraft(detailSchedule.id, value)}
                        onBlur={() => commitIntervalDraft(detailSchedule.id)}
                        keyboardType="number-pad"
                        style={[
                          styles.intervalInput,
                          {
                            backgroundColor: colors.inputBackground,
                            color: colors.textPrimary,
                            borderColor: colors.border,
                          },
                        ]}
                      />
                      <Text style={[styles.intervalUnit, { color: colors.textSecondary }]}>min</Text>
                      <Pressable
                        style={[styles.stepperButton, { backgroundColor: colors.accent }]}
                        onPress={() => stepInterval(detailSchedule.id, 1)}
                        accessibilityRole="button"
                        accessibilityLabel="Increase interval"
                      >
                        <Text style={styles.stepperLabel}>+</Text>
                      </Pressable>
                    </View>
                  </View>
                ) : null}

                {detailScheduleType === 'weekly' || detailScheduleType === 'withinDay' ? (
                  <View style={styles.detailSubsection}>
                    <Text style={[styles.detailSectionTitle, { color: colors.textSecondary }]}>
                      Days
                    </Text>
                    <View style={styles.dayRow}>
                      {DAY_LABELS.map((label, dayIndex) => {
                        const isSelected = detailScheduleDays[dayIndex];
                        return (
                          <Pressable
                            key={label}
                            style={[
                              styles.dayButton,
                              {
                                backgroundColor: isSelected ? colors.accent : colors.inputBackground,
                                borderColor: isSelected ? colors.accent : colors.border,
                              },
                            ]}
                            onPress={() => toggleScheduleDay(detailSchedule.id, dayIndex)}
                          >
                            <Text
                              style={[
                                styles.dayLabel,
                                { color: isSelected ? '#FFFFFF' : colors.textSecondary },
                              ]}
                            >
                              {label}
                            </Text>
                          </Pressable>
                        );
                      })}
                    </View>
                  </View>
                ) : null}

                {detailScheduleType === 'monthly' ? (
                  <View style={styles.detailSubsection}>
                    <Text style={[styles.detailSectionTitle, { color: colors.textSecondary }]}>
                      Day of month
                    </Text>
                    <View
                      style={[
                        styles.intervalRow,
                        { backgroundColor: colors.inputBackground, borderColor: colors.border },
                      ]}
                    >
                      <Pressable
                        style={[styles.stepperButton, { backgroundColor: colors.accent }]}
                        onPress={() => stepDayOfMonth(detailSchedule.id, -1)}
                        accessibilityRole="button"
                        accessibilityLabel="Decrease day"
                      >
                        <Text style={styles.stepperLabel}>-</Text>
                      </Pressable>
                      <TextInput
                        value={detailDayOfMonthValue}
                        onChangeText={(value) => updateDayOfMonthDraft(detailSchedule.id, value)}
                        onBlur={() => commitDayOfMonthDraft(detailSchedule.id)}
                        keyboardType="number-pad"
                        style={[
                          styles.intervalInput,
                          {
                            backgroundColor: colors.inputBackground,
                            color: colors.textPrimary,
                            borderColor: colors.border,
                          },
                        ]}
                      />
                      <Text style={[styles.intervalUnit, { color: colors.textSecondary }]}>day</Text>
                      <Pressable
                        style={[styles.stepperButton, { backgroundColor: colors.accent }]}
                        onPress={() => stepDayOfMonth(detailSchedule.id, 1)}
                        accessibilityRole="button"
                        accessibilityLabel="Increase day"
                      >
                        <Text style={styles.stepperLabel}>+</Text>
                      </Pressable>
                    </View>
                  </View>
                ) : null}
              </View>

              <View style={styles.detailTestRow}>
                <Pressable
                  onPress={() => void sendTestNotification(detailSchedule)}
                  accessibilityRole="button"
                  accessibilityLabel="Test notification"
                  hitSlop={8}
                >
                  <Text style={[styles.detailTestLink, { color: colors.textSecondary }]}>
                    Send test notification
                  </Text>
                </Pressable>
              </View>
              </Reanimated.ScrollView>
            </Reanimated.View>
          </GestureDetector>
        </View>
      ) : null}

      {activePicker && (activeSchedule || activePicker.scheduleId === 'quiet') ? (
        <View style={[styles.sheetBackdrop, { backgroundColor: colors.sheetBackdrop }]}>
          <View style={[styles.sheet, { backgroundColor: glassSheet }]}>
            <BlurView
              intensity={glassBlurIntensity}
              tint={colorScheme === 'dark' ? 'dark' : 'light'}
              style={[StyleSheet.absoluteFillObject, { borderRadius: 20 }]}
              pointerEvents="none"
            />
            <View style={styles.sheetHeader}>
              <Text style={[styles.sheetTitle, { color: colors.textPrimary }]}>
                {activePicker.scheduleId === 'quiet'
                  ? activePicker.kind === 'start'
                    ? 'Quiet hours start'
                    : 'Quiet hours end'
                  : activePicker.kind === 'start'
                    ? getScheduleType(activeSchedule?.type) === 'withinDay'
                      ? 'Start time'
                      : 'Time'
                    : 'End time'}
              </Text>
              <Pressable onPress={() => setActivePicker(null)}>
                <Text style={[styles.sheetDone, { color: colors.accent }]}>Done</Text>
              </Pressable>
            </View>
            <DateTimePicker
              value={activePickerDate}
              mode="time"
              display="spinner"
              themeVariant={colorScheme === 'dark' ? 'dark' : 'light'}
              textColor={colors.textPrimary}
              onChange={onPickerChange}
            />
          </View>
        </View>
      ) : null}

      {isOnboardingVisible ? (
        <View style={[styles.onboardingBackdrop, { backgroundColor: colors.sheetBackdrop }]}>
          <View
            style={[
              styles.onboardingCard,
              { backgroundColor: glassCard, borderColor: glassBorder, shadowColor: colors.shadow },
            ]}
          >
            <BlurView
              intensity={glassBlurIntensity}
              tint={colorScheme === 'dark' ? 'dark' : 'light'}
              style={[StyleSheet.absoluteFillObject, { borderRadius: 18 }]}
              pointerEvents="none"
            />
            <Text style={[styles.onboardingTitle, { color: colors.textPrimary }]}>
              Welcome to Never4Get
            </Text>
            <Text style={[styles.onboardingText, { color: colors.textSecondary }]}>
              Enable notifications so we can remind you.
            </Text>
            <Pressable
              style={[
                styles.onboardingButton,
                { backgroundColor: colors.accent, borderColor: colors.accent },
              ]}
              onPress={() => void enableNotificationsFromOnboarding()}
            >
              <Text style={styles.onboardingButtonLabel}>Enable notifications</Text>
            </Pressable>
          </View>
        </View>
      ) : null}

    </SafeAreaView>
  );
}

export default function App() {
  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SafeAreaProvider>
        <ColorSchemeProvider>
          <AppContent />
        </ColorSchemeProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}

const minutesToDate = (minutes: number) => {
  const date = new Date();
  date.setHours(0, 0, 0, 0);
  date.setMinutes(minutes);
  return date;
};

const dateToMinutes = (date: Date) => date.getHours() * 60 + date.getMinutes();

const formatTime = (minutes: number) => {
  const date = minutesToDate(minutes);
  return new Intl.DateTimeFormat(undefined, { timeStyle: 'short' }).format(date);
};

const formatError = (error: unknown) => {
  if (error instanceof Error && error.message) {
    return error.message;
  }
  return 'Please try again.';
};

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
  },
  flex: {
    flex: 1,
  },
  container: {
    padding: 18,
    gap: 12,
    minHeight: '100%',
  },
  settingsContainer: {
    flex: 1,
    padding: 18,
    paddingBottom: TAB_BAR_HEIGHT + 32,
    gap: 12,
  },
  settingsRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 16,
  },
  settingsText: {
    flex: 1,
    gap: 6,
  },
  settingsLabel: {
    fontSize: FONT_SIZE_MD,
    fontWeight: '700',
    fontFamily: FONT_BOLD,
  },
  settingsHelper: {
    fontSize: FONT_SIZE_SM,
  },
  settingsSectionTitle: {
    fontSize: FONT_SIZE_MD,
    fontWeight: '700',
    fontFamily: FONT_BOLD,
  },
  scroll: {
    flex: 1,
  },
  title: {
    fontSize: FONT_SIZE_TITLE,
    fontWeight: '700',
    fontFamily: FONT_BOLD,
    letterSpacing: -0.5,
  },
  headerBar: {
    paddingHorizontal: 18,
    paddingTop: 18,
    paddingBottom: 8,
    gap: 10,
    borderBottomLeftRadius: 18,
    borderBottomRightRadius: 18,
    borderBottomWidth: 0.75,
    overflow: 'hidden',
  },
  headerActions: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    width: '100%',
  },
  headerActionButton: {
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 16,
    borderWidth: 0.75,
  },
  headerActionText: {
    fontSize: FONT_SIZE_MD,
    fontWeight: '700',
    fontFamily: FONT_MEDIUM,
  },
  alarmList: {
    borderRadius: 22,
    borderWidth: 1,
    overflow: 'hidden',
    shadowOpacity: 0.12,
    shadowRadius: 18,
    shadowOffset: { width: 0, height: 8 },
    elevation: 8,
  },
  alarmRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
    paddingHorizontal: 16,
    paddingVertical: 14,
  },
  alarmRowMain: {
    flex: 1,
    gap: 4,
  },
  alarmSections: {
    gap: 12,
  },
  alarmSection: {
    gap: 8,
  },
  alarmSectionTitle: {
    fontSize: FONT_SIZE_SM,
    fontWeight: '700',
    fontFamily: FONT_BOLD,
    letterSpacing: 1,
    textTransform: 'uppercase',
  },
  alarmToggle: {
    alignSelf: 'stretch',
    alignItems: 'center',
    justifyContent: 'center',
  },
  alarmTime: {
    fontSize: FONT_SIZE_LG,
    fontWeight: '700',
    fontFamily: FONT_REGULAR,
    letterSpacing: -0.6,
  },
  alarmLabel: {
    fontSize: FONT_SIZE_MD,
    fontWeight: '700',
    fontFamily: FONT_MEDIUM,
  },
  alarmSubtext: {
    fontSize: FONT_SIZE_SM,
    fontFamily: FONT_REGULAR,
  },
  alarmSubtextGroup: {
    gap: 2,
  },
  alarmDelete: {
    paddingRight: 4,
  },
  alarmDeleteBadge: {
    width: 26,
    height: 26,
    borderRadius: 13,
    alignItems: 'center',
    justifyContent: 'center',
  },
  alarmDeleteText: {
    color: '#FFFFFF',
    fontSize: FONT_SIZE_MD,
    fontWeight: '700',
    fontFamily: FONT_BOLD,
    marginTop: -1,
  },
  topFade: {
    position: 'absolute',
    left: 0,
    right: 0,
  },
  bottomFade: {
    position: 'absolute',
    left: 0,
    right: 0,
  },
  addButton: {
    width: 40,
    height: 40,
    borderRadius: 20,
    borderWidth: 0.75,
    alignItems: 'center',
    justifyContent: 'center',
  },
  card: {
    borderRadius: 20,
    padding: 20,
    gap: 16,
    borderWidth: 1,
    overflow: 'hidden',
    shadowOpacity: 0.16,
    shadowRadius: 24,
    shadowOffset: { width: 0, height: 10 },
    elevation: 12,
  },
  cardHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingBottom: 2,
  },
  cardHeaderActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  cardTitleButton: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingRight: 20,
  },
  cardTitleInput: {
    fontSize: FONT_SIZE_LG,
    fontWeight: '700',
    fontFamily: FONT_BOLD,
    flex: 1,
    marginRight: 12,
    paddingVertical: 0,
    paddingHorizontal: 0,
  },
  chevron: {
    width: 16,
    height: 10,
    alignItems: 'center',
    justifyContent: 'center',
  },
  chevronLine: {
    position: 'absolute',
    width: 10,
    height: 2,
    borderRadius: 2,
  },
  chevronLeft: {
    transform: [{ rotate: '45deg' }],
    left: 0,
  },
  chevronRight: {
    transform: [{ rotate: '-45deg' }],
    right: 0,
  },
  menuLabel: {
    fontSize: FONT_SIZE_XL,
    fontWeight: '700',
    fontFamily: FONT_BOLD,
    letterSpacing: 1,
  },
  cardSummary: {
    fontSize: FONT_SIZE_XS,
    fontFamily: FONT_REGULAR,
    marginBottom: 6,
  },
  cardActionRow: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
  },
  testButton: {
    borderRadius: 12,
    borderWidth: 1,
    paddingHorizontal: 12,
    paddingVertical: 8,
    alignItems: 'center',
  },
  testButtonLabel: {
    fontSize: FONT_SIZE_XS,
    fontWeight: '700',
    fontFamily: FONT_BOLD,
  },
  toggleButton: {
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 8,
    width: 92,
    alignItems: 'center',
    shadowOpacity: 0.12,
    shadowRadius: 6,
    shadowOffset: { width: 0, height: 2 },
    elevation: 3,
  },
  toggleButtonLabel: {
    color: '#FFFFFF',
    fontSize: FONT_SIZE_XS,
    fontWeight: '700',
    fontFamily: FONT_BOLD,
  },
  divider: {
    height: 1,
    width: '100%',
  },
  intervalRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 14,
    paddingVertical: 12,
    borderRadius: 14,
    borderWidth: 0,
  },
  intervalInputGroup: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  intervalInput: {
    minWidth: 50,
    textAlign: 'center',
    borderWidth: 0,
    borderRadius: 12,
    paddingVertical: 8,
    paddingHorizontal: 10,
    fontSize: FONT_SIZE_MD,
    fontWeight: '700',
    fontFamily: FONT_MEDIUM,
  },
  intervalUnit: {
    fontSize: FONT_SIZE_SM,
    fontWeight: '700',
    fontFamily: FONT_MEDIUM,
  },
  stepperButton: {
    width: 36,
    height: 36,
    borderRadius: 12,
    borderWidth: 0,
    alignItems: 'center',
    justifyContent: 'center',
    shadowOpacity: 0.1,
    shadowRadius: 6,
    shadowOffset: { width: 0, height: 2 },
    elevation: 3,
  },
  stepperLabel: {
    fontSize: FONT_SIZE_XL,
    color: '#FFFFFF',
    fontWeight: '700',
    fontFamily: FONT_BOLD,
  },
  intervalValue: {
    fontSize: FONT_SIZE_MD,
    fontWeight: '700',
    fontFamily: FONT_MEDIUM,
  },
  timeRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 12,
    paddingHorizontal: 16,
    borderRadius: 14,
    borderWidth: 0,
  },
  timeRowGroup: {
    gap: 8,
    marginTop: 8,
  },
  timeLabel: {
    fontSize: FONT_SIZE_MD,
    fontWeight: '700',
    fontFamily: FONT_MEDIUM,
  },
  timeValue: {
    fontSize: FONT_SIZE_MD,
    fontWeight: '700',
    fontFamily: FONT_MEDIUM,
  },
  dayRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
  },
  dayButton: {
    flex: 1,
    aspectRatio: 1,
    borderRadius: 12,
    borderWidth: 0,
    alignItems: 'center',
    justifyContent: 'center',
    shadowOpacity: 0.08,
    shadowRadius: 4,
    shadowOffset: { width: 0, height: 2 },
    elevation: 2,
  },
  dayLabel: {
    fontSize: FONT_SIZE_XS,
    fontWeight: '700',
    fontFamily: FONT_BOLD,
  },
  helperText: {
    fontSize: FONT_SIZE_XS,
    fontFamily: FONT_REGULAR,
  },
  emptyState: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 12,
  },
  emptyStateTitle: {
    fontSize: FONT_SIZE_XL,
    fontWeight: '700',
    fontFamily: FONT_BOLD,
  },
  emptyStateButton: {
    borderRadius: 14,
    paddingVertical: 12,
    paddingHorizontal: 18,
    alignItems: 'center',
  },
  emptyStateButtonLabel: {
    color: '#FFFFFF',
    fontSize: FONT_SIZE_MD,
    fontWeight: '700',
    fontFamily: FONT_BOLD,
  },
  messageBlock: {
    gap: 6,
  },
  monthBlock: {
    gap: 6,
  },
  messageLabel: {
    fontSize: FONT_SIZE_XS,
    fontWeight: '700',
    fontFamily: FONT_MEDIUM,
  },
  messageInput: {
    borderRadius: 14,
    paddingHorizontal: 16,
    paddingVertical: 12,
    fontSize: FONT_SIZE_MD,
    fontFamily: FONT_REGULAR,
    borderWidth: 0,
  },
  cardButton: {
    borderRadius: 14,
    paddingVertical: 14,
    alignItems: 'center',
    shadowOpacity: 0.15,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 2 },
    elevation: 4,
  },
  cardButtonLabel: {
    color: '#FFFFFF',
    fontSize: FONT_SIZE_MD,
    fontWeight: '700',
    fontFamily: FONT_BOLD,
  },
  secondaryButton: {
    borderRadius: 14,
    borderWidth: 1.5,
    paddingVertical: 14,
    alignItems: 'center',
  },
  secondaryButtonLabel: {
    fontSize: FONT_SIZE_MD,
    fontWeight: '700',
    fontFamily: FONT_BOLD,
  },
  namePrompt: {
    marginHorizontal: 18,
    padding: 24,
    borderRadius: 24,
    borderWidth: 0,
    overflow: 'hidden',
    shadowOpacity: 0.15,
    shadowRadius: 20,
    shadowOffset: { width: 0, height: 8 },
    gap: 16,
    elevation: 10,
  },
  typeSelector: {
    gap: 8,
  },
  typeLabel: {
    fontSize: FONT_SIZE_XS,
    fontWeight: '700',
    fontFamily: FONT_MEDIUM,
  },
  typeOptions: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  typeOption: {
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 12,
    borderWidth: 1,
  },
  typeOptionText: {
    fontSize: FONT_SIZE_XS,
    fontWeight: '700',
    fontFamily: FONT_BOLD,
  },
  typeHelper: {
    fontSize: FONT_SIZE_XS,
    fontFamily: FONT_REGULAR,
  },
  namePromptTitle: {
    fontSize: FONT_SIZE_LG,
    fontWeight: '700',
    fontFamily: FONT_BOLD,
  },
  namePromptInput: {
    borderRadius: 14,
    paddingHorizontal: 16,
    paddingVertical: 12,
    fontSize: FONT_SIZE_MD,
    fontFamily: FONT_REGULAR,
    borderWidth: 0,
  },
  namePromptActions: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginTop: 4,
  },
  namePromptCancel: {
    fontSize: FONT_SIZE_MD,
    fontWeight: '700',
    fontFamily: FONT_MEDIUM,
  },
  namePromptButton: {
    borderRadius: 14,
    paddingHorizontal: 24,
    paddingVertical: 12,
    shadowOpacity: 0.15,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 2 },
    elevation: 4,
  },
  namePromptButtonLabel: {
    color: '#FFFFFF',
    fontSize: FONT_SIZE_MD,
    fontWeight: '700',
    fontFamily: FONT_BOLD,
  },
  menuSheet: {
    marginHorizontal: 18,
    marginBottom: 18,
    borderRadius: 24,
    borderWidth: 0,
    overflow: 'hidden',
    shadowOpacity: 0.15,
    shadowRadius: 20,
    shadowOffset: { width: 0, height: 8 },
    paddingVertical: 8,
    elevation: 10,
  },
  menuItem: {
    paddingHorizontal: 20,
    paddingVertical: 12,
  },
  menuItemContent: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  menuItemText: {
    fontSize: FONT_SIZE_MD,
    fontWeight: '700',
    fontFamily: FONT_BOLD,
  },
  menuCancel: {
    paddingHorizontal: 20,
    paddingVertical: 12,
  },
  menuCancelContent: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
  },
  menuCancelText: {
    fontSize: FONT_SIZE_MD,
    fontWeight: '700',
    fontFamily: FONT_BOLD,
    textAlign: 'center',
  },
  mapPickerCard: {
    marginHorizontal: 18,
    marginBottom: 24,
    borderRadius: 18,
    borderWidth: 1,
    overflow: 'hidden',
    padding: 16,
    gap: 12,
    shadowOpacity: 0.08,
    shadowRadius: 14,
    shadowOffset: { width: 0, height: 8 },
  },
  mapPickerHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  mapPickerTitle: {
    fontSize: FONT_SIZE_LG,
    fontWeight: '700',
    fontFamily: FONT_BOLD,
  },
  mapPickerMap: {
    height: 320,
    borderRadius: 16,
    overflow: 'hidden',
  },
  mapPickerPin: {
    position: 'absolute',
    left: '50%',
    top: '50%',
    transform: [{ translateX: -17 }, { translateY: -34 }],
  },
  mapPickerActions: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
  },
  namePromptWrapper: {
    flex: 1,
    justifyContent: 'flex-end',
    paddingBottom: 16,
  },
  sheetBackdrop: {
    ...StyleSheet.absoluteFillObject,
    justifyContent: 'flex-end',
  },
  detailBackdrop: {
    ...StyleSheet.absoluteFillObject,
    justifyContent: 'flex-end',
  },
  detailBackdropFill: {
    ...StyleSheet.absoluteFillObject,
  },
  detailSheet: {
    paddingTop: 12,
    paddingHorizontal: 16,
    borderTopLeftRadius: 26,
    borderTopRightRadius: 26,
    borderWidth: 1,
    overflow: 'hidden',
  },
  detailHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingBottom: 8,
  },
  detailHeaderButton: {
    width: 36,
    height: 36,
    borderRadius: 18,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  detailTitle: {
    fontSize: FONT_SIZE_MD,
    fontWeight: '700',
    fontFamily: FONT_BOLD,
  },
  detailContent: {
    gap: 16,
    paddingBottom: 12,
  },
  detailScroll: {
    flex: 1,
  },
  detailPickerGroup: {
    gap: 12,
  },
  detailTimeGroup: {
    borderRadius: 18,
    borderWidth: 1,
    overflow: 'hidden',
  },
  detailTimeDivider: {
    height: 1,
    marginHorizontal: 16,
  },
  detailSection: {
    borderRadius: 18,
    borderWidth: 1,
    padding: 14,
    gap: 12,
    overflow: 'hidden',
  },
  detailSectionTitle: {
    fontSize: FONT_SIZE_SM,
    fontWeight: '700',
    fontFamily: FONT_MEDIUM,
  },
  detailSubsection: {
    gap: 8,
  },
  detailRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
  },
  detailRowLabel: {
    fontSize: FONT_SIZE_MD,
    fontWeight: '700',
    fontFamily: FONT_MEDIUM,
  },
  detailRowInput: {
    flex: 1,
    textAlign: 'right',
    fontSize: FONT_SIZE_MD,
    fontFamily: FONT_REGULAR,
    paddingVertical: 0,
    paddingHorizontal: 0,
  },
  detailDivider: {
    height: 1,
    width: '100%',
  },
  detailTestRow: {
    alignItems: 'flex-start',
    paddingHorizontal: 4,
    paddingTop: 4,
  },
  detailTestLink: {
    fontSize: FONT_SIZE_SM,
    fontWeight: '700',
    fontFamily: FONT_MEDIUM,
  },
  onboardingBackdrop: {
    ...StyleSheet.absoluteFillObject,
    justifyContent: 'center',
    padding: 24,
  },
  onboardingCard: {
    borderRadius: 18,
    borderWidth: 1,
    overflow: 'hidden',
    padding: 18,
    gap: 12,
    shadowOpacity: 0.06,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 8 },
  },
  onboardingTitle: {
    fontSize: FONT_SIZE_XL,
    fontWeight: '700',
    fontFamily: FONT_BOLD,
  },
  onboardingText: {
    fontSize: FONT_SIZE_SM,
    lineHeight: 20,
  },
  onboardingButton: {
    borderRadius: 12,
    paddingVertical: 10,
    alignItems: 'center',
    borderWidth: 1,
  },
  onboardingButtonLabel: {
    color: '#FFFFFF',
    fontSize: FONT_SIZE_SM,
    fontWeight: '700',
    fontFamily: FONT_BOLD,
  },
  sheet: {
    paddingTop: 12,
    paddingHorizontal: 16,
    paddingBottom: 24,
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    overflow: 'hidden',
  },
  sheetHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingBottom: 8,
  },
  sheetTitle: {
    fontSize: FONT_SIZE_MD,
    fontWeight: '700',
  },
  sheetDone: {
    fontSize: FONT_SIZE_MD,
    fontWeight: '700',
  },
  tabBar: {
    borderTopWidth: 0,
    height: TAB_BAR_HEIGHT,
    alignItems: 'center',
    justifyContent: 'center',
    paddingTop: 8,
  },
  tabPill: {
    minWidth: 350,
    paddingVertical: 10,
    paddingHorizontal: 26,
    borderRadius: 28,
    borderWidth: 1,
    overflow: 'hidden',
    shadowOpacity: 0.18,
    shadowRadius: 16,
    shadowOffset: { width: 0, height: 8 },
    elevation: 10,
  },
  tabPillContent: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 18,
  },
  tabButton: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 4,
    paddingVertical: 6,
  },
  tabIcon: {
    height: 25,
    marginTop: 2,
  },
  tabLabel: {
    fontSize: FONT_SIZE_XS,
    fontWeight: '700',
    fontFamily: FONT_MEDIUM,
  },
});

const lightColors = {
  background: '#E3ECE1',
  card: '#FAFDF9',
  textPrimary: '#1C2B1A',
  textSecondary: '#1C2B1A',
  textMuted: '#1C2B1A',
  label: '#1C2B1A',
  inputBackground: '#E8F0E6',
  inputText: '#1C2B1A',
  placeholder: '#7A8F77',
  accent: '#4A7C59',
  active: '#5C9B6E',
  inactive: '#D8E3D6',
  stop: '#C65D3B',
  shadow: '#4A7C59',
  inline: '#6B9B7E',
  sheet: '#FAFDF9',
  sheetBackdrop: 'rgba(28, 43, 26, 0.5)',
  remove: '#C65D3B',
  border: '#DDE8DB',
};

const darkColors = {
  background: '#1C1C1E',
  card: '#464649',
  textPrimary: '#E7E9EA',
  textSecondary: '#B0B3B8',
  textMuted: '#8E9298',
  label: '#E7E9EA',
  inputBackground: '#202327',
  inputText: '#E7E9EA',
  placeholder: '#71767B',
  accent: '#1D9BF0',
  active: '#00BA7C',
  inactive: '#2F3336',
  stop: '#F4212E',
  shadow: '#000000',
  inline: '#8B6FFF',
  sheet: '#16181C',
  sheetBackdrop: 'rgba(91, 112, 131, 0.4)',
  remove: '#F4212E',
  border: '#242427',
};

