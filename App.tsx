import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert,
  Animated,
  Easing,
  InteractionManager,
  Keyboard,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  View,
} from 'react-native';
import DateTimePicker, { DateTimePickerEvent } from '@react-native-community/datetimepicker';
import MaterialIcons from '@expo/vector-icons/MaterialIcons';
import { StatusBar } from 'expo-status-bar';
import AsyncStorage from '@react-native-async-storage/async-storage';
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
  StoredSettings,
  QuietHours,
} from './src/storage';

const MIN_INTERVAL = 5;
const MAX_INTERVAL = 180;
const DEFAULT_DAYS = [true, true, true, true, true, true, true];
const OVERNIGHT_NOTICE_KEY = 'settings.overnightNoticeShown';
const DAY_LABELS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const FONT_REGULAR = 'System';
const FONT_MEDIUM = 'System';
const FONT_BOLD = 'System';
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

const getDefaultNotificationName = (index: number) => `Notification ${index + 1}`;
const normalizeDaysOfWeek = (value?: boolean[]) => {
  if (!Array.isArray(value) || value.length !== 7) {
    return DEFAULT_DAYS;
  }
  return value.map((entry) => Boolean(entry));
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

const formatTimeRangeSummary = (startMinutes: number, endMinutes: number) => {
  if (startMinutes === endMinutes) {
    return 'All day';
  }
  return `${formatTime(startMinutes)} - ${formatTime(endMinutes)}`;
};

const formatNotificationName = (value: string) => {
  const trimmed = value.trim();
  if (!trimmed) {
    return '';
  }
  return trimmed.replace(/(^\\w)|(\\s+\\w)/g, (match) => match.toUpperCase());
};

const createSchedule = (name: string): Schedule => ({
  id: `${Date.now()}_${Math.random().toString(16).slice(2)}`,
  name,
  intervalMinutes: 30,
  startMinutesFromMidnight: 9 * 60,
  endMinutesFromMidnight: 21 * 60,
  daysOfWeek: DEFAULT_DAYS.slice(),
  message: '',
  isActive: false,
});

const DEFAULT_SETTINGS: StoredSettings = {
  schedules: [createSchedule(getDefaultNotificationName(0))],
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
  const [isNamePromptOpen, setIsNamePromptOpen] = useState(false);
  const [nameDraft, setNameDraft] = useState('');
  const [namePromptMode, setNamePromptMode] = useState<'add' | 'edit'>('add');
  const [namePromptScheduleId, setNamePromptScheduleId] = useState<string | null>(null);
  const [menuScheduleId, setMenuScheduleId] = useState<string | null>(null);
  const [collapsedSchedules, setCollapsedSchedules] = useState<string[]>([]);
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
  const darkModeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const keyboardOffset = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    if (activeTab === 'home') {
      return;
    }
    setActivePicker(null);
    setMenuScheduleId(null);
    setIsNamePromptOpen(false);
    Keyboard.dismiss();
  }, [activeTab]);

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
    const hasOvernight = schedules.some((schedule) =>
      isOvernightWindow(schedule.startMinutesFromMidnight, schedule.endMinutesFromMidnight)
    );
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
    if (Platform.OS === 'ios') {
      const sub = Keyboard.addListener('keyboardWillChangeFrame', (event) => {
        const height = event.endCoordinates?.height ?? 0;
        const target = Math.max(0, height + 16);
        Animated.timing(keyboardOffset, {
          toValue: target,
          duration: event.duration ?? 250,
          easing: Easing.out(Easing.cubic),
          useNativeDriver: true,
        }).start();
      });
      return () => {
        sub.remove();
      };
    }
    const showSub = Keyboard.addListener('keyboardDidShow', (event) => {
      const height = event.endCoordinates?.height ?? 0;
      const target = Math.max(0, height + 16);
      Animated.timing(keyboardOffset, {
        toValue: target,
        duration: 200,
        easing: Easing.out(Easing.cubic),
        useNativeDriver: true,
      }).start();
    });
    const hideSub = Keyboard.addListener('keyboardDidHide', () => {
      Animated.timing(keyboardOffset, {
        toValue: 0,
        duration: 180,
        easing: Easing.out(Easing.cubic),
        useNativeDriver: true,
      }).start();
    });
    return () => {
      showSub.remove();
      hideSub.remove();
    };
  }, [keyboardOffset]);

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
        schedule.intervalMinutes !== previous.intervalMinutes ||
        schedule.startMinutesFromMidnight !== previous.startMinutesFromMidnight ||
        schedule.endMinutesFromMidnight !== previous.endMinutesFromMidnight ||
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

  const sendTestNotification = async (schedule: Schedule, index: number) => {
    const scheduleName = schedule.name?.trim() || getDefaultNotificationName(index);
    const titleSuffix = schedule.name.trim() ? ` - ${schedule.name.trim()}` : '';
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
    await cancelScheduleNotifications(schedule.id);
    return scheduleNotificationsBatch([schedule], { quietHours });
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
        setInlineMessage(
          quietHours.enabled
            ? 'No alerts outside quiet hours. Adjust the window or quiet hours.'
            : 'No alerts in the next 7 days. Adjust the window.'
        );
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
        setInlineMessage(
          quietHours.enabled
            ? 'No alerts outside quiet hours. Adjust the window or quiet hours.'
            : 'No alerts in the next 7 days. Adjust the window.'
        );
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
    setSchedules((current) =>
      current.map((schedule) =>
        schedule.id === id ? { ...schedule, ...patch } : schedule
      )
    );
  };

  const stepInterval = (id: string, direction: 1 | -1) => {
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
    const schedule = schedules.find((item) => item.id === id);
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

  const toggleScheduleDay = (id: string, dayIndex: number) => {
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

  const toggleScheduleCollapse = (id: string) => {
    setCollapsedSchedules((current) =>
      current.includes(id) ? current.filter((entry) => entry !== id) : [...current, id]
    );
  };

  const addSchedule = () => {
    setActivePicker(null);
    if (Platform.OS === 'ios') {
      Alert.prompt(
        'New notification',
        undefined,
        [
          { text: 'Cancel', style: 'cancel' },
          {
            text: 'Add',
            onPress: (text) => {
              const formatted = formatNotificationName(text ?? '');
              if (!formatted) {
                return;
              }
              setSchedules((current) => [...current, createSchedule(formatted)]);
            },
          },
        ],
        'plain-text'
      );
      return;
    }
    setNameDraft('');
    setNamePromptMode('add');
    setNamePromptScheduleId(null);
    setIsNamePromptOpen(true);
  };

  const editScheduleName = (schedule: Schedule) => {
    if (Platform.OS === 'ios') {
      Alert.prompt(
        'Edit notification',
        undefined,
        [
          { text: 'Cancel', style: 'cancel' },
          {
            text: 'Save',
            onPress: (text) => {
              const formatted = formatNotificationName(text ?? '');
              if (!formatted) {
                return;
              }
              updateSchedule(schedule.id, { name: formatted });
            },
          },
        ],
        'plain-text',
        schedule.name
      );
      return;
    }
    setNameDraft(schedule.name);
    setNamePromptMode('edit');
    setNamePromptScheduleId(schedule.id);
    setIsNamePromptOpen(true);
  };

  const duplicateSchedule = (schedule: Schedule) => {
    const baseName = schedule.name?.trim() || getDefaultNotificationName(schedules.length);
    const nextName = `${baseName} copy`;
    const newSchedule: Schedule = {
      ...schedule,
      id: `${Date.now()}_${Math.random().toString(16).slice(2)}`,
      name: nextName,
      isActive: false,
    };
    setSchedules((current) => [...current, newSchedule]);
    setInlineMessage(`Duplicated "${baseName}".`);
  };

  const closeMenu = () => {
    setMenuScheduleId(null);
  };

  const closeNamePrompt = () => {
    Keyboard.dismiss();
    setNamePromptScheduleId(null);
    setIsNamePromptOpen(false);
  };

  const confirmNamePrompt = () => {
    const formatted = formatNotificationName(nameDraft);
    if (!formatted) {
      return;
    }
    if (namePromptMode === 'add') {
      setSchedules((current) => [...current, createSchedule(formatted)]);
    } else if (namePromptMode === 'edit' && namePromptScheduleId) {
      updateSchedule(namePromptScheduleId, { name: formatted });
    }
    closeNamePrompt();
  };

  const removeSchedule = async (id: string) => {
    clearRescheduleTimer(id);
    try {
      await cancelScheduleNotifications(id);
    } catch {
      // Ignore cancellation errors during removal.
    }
    setActivePicker((current) => (current?.scheduleId === id ? null : current));
    setSchedules((current) => current.filter((schedule) => schedule.id !== id));
    setCollapsedSchedules((current) => current.filter((entry) => entry !== id));
    setIntervalDrafts((current) => {
      const { [id]: _, ...rest } = current;
      return rest;
    });
  };

  const activeSchedule = useMemo(() => {
    if (!activePicker || activePicker.scheduleId === 'quiet') {
      return null;
    }
    return schedules.find((schedule) => schedule.id === activePicker.scheduleId) ?? null;
  }, [activePicker, schedules]);

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

  const canConfirmName = nameDraft.trim().length > 0;
  const isEditingName = namePromptMode === 'edit';
  const namePromptTitle = isEditingName ? 'Edit notification' : 'New notification';
  const namePromptPlaceholder = 'Notification name';

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
      updateSchedule(activePicker.scheduleId, { startMinutesFromMidnight: minutes });
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
    if (Platform.OS === 'ios') {
      darkModeTimerRef.current = setTimeout(() => {
        setDarkMode(value);
      }, 200);
      return;
    }
    setDarkMode(value);
  };

  return (
    <SafeAreaView edges={['top']} style={[styles.safeArea, { backgroundColor: colors.background }]}>
      <StatusBar style={colorScheme === 'dark' ? 'light' : 'dark'} backgroundColor={colors.background} />
      {activeTab === 'home' ? (
        <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        keyboardVerticalOffset={Platform.OS === 'ios' ? 80 : 0}
        style={styles.flex}
      >
        <ScrollView
          style={styles.scroll}
          contentContainerStyle={[styles.container, { backgroundColor: colors.background }]}
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="interactive"
          contentInsetAdjustmentBehavior="always"
          automaticallyAdjustKeyboardInsets
          showsVerticalScrollIndicator={false}
        >
          <View style={styles.titleRow}>
            <Text style={[styles.title, { color: colors.textPrimary }]}>Notifications</Text>
            <Pressable
              style={[
                styles.addButton,
                { backgroundColor: colors.inputBackground, borderColor: colors.border },
              ]}
              onPress={addSchedule}
              accessibilityRole="button"
              accessibilityLabel="Add notification"
              hitSlop={8}
            >
              <MaterialIcons name="add" size={22} color={colors.accent} />
            </Pressable>
          </View>

          {schedules.map((schedule, index) => {
            const startLabel = formatTime(schedule.startMinutesFromMidnight);
            const endLabel = formatTime(schedule.endMinutesFromMidnight);
            const daysOfWeek = normalizeDaysOfWeek(schedule.daysOfWeek);
            const isOvernight = isOvernightWindow(
              schedule.startMinutesFromMidnight,
              schedule.endMinutesFromMidnight
            );
            const daysSummary = formatDaysSummary(daysOfWeek);
            const timeSummary = formatTimeRangeSummary(
              schedule.startMinutesFromMidnight,
              schedule.endMinutesFromMidnight
            );
            const summary = `${daysSummary} | ${timeSummary} | Every ${schedule.intervalMinutes} min`;
            const isCollapsed = collapsedSchedules.includes(schedule.id);
            const scheduleDisplayName =
              schedule.name?.trim() || getDefaultNotificationName(index);
            return (
              <View
                key={schedule.id}
                style={[
                  styles.card,
                  {
                    backgroundColor: colors.card,
                    shadowColor: colors.shadow,
                    borderColor: schedule.isActive ? colors.accent : colors.border,
                    shadowOpacity: schedule.isActive ? 0.12 : 0.04,
                  },
                ]}
              >
                <View style={styles.cardHeader}>
                  <Pressable
                    style={styles.cardTitleButton}
                    onPress={() => toggleScheduleCollapse(schedule.id)}
                  >
                    <Text style={[styles.cardTitleInput, { color: colors.textPrimary }]}>
                      {scheduleDisplayName}
                    </Text>
                    <View
                      style={[
                        styles.chevron,
                        { transform: [{ rotate: isCollapsed ? '0deg' : '180deg' }] },
                      ]}
                    >
                      <View
                        style={[
                          styles.chevronLine,
                          styles.chevronLeft,
                          { backgroundColor: colors.textSecondary },
                        ]}
                      />
                      <View
                        style={[
                          styles.chevronLine,
                          styles.chevronRight,
                          { backgroundColor: colors.textSecondary },
                        ]}
                      />
                    </View>
                  </Pressable>
                  <View style={styles.cardHeaderActions}>
                    <Pressable
                      style={[
                        styles.toggleButton,
                        { backgroundColor: schedule.isActive ? colors.active : colors.inactive },
                      ]}
                      onPress={() =>
                        schedule.isActive
                          ? void onStopSchedule(schedule.id)
                          : void onStartSchedule(schedule.id)
                      }
                    >
                      <Text style={styles.toggleButtonLabel}>
                        {schedule.isActive ? 'Active' : 'Inactive'}
                      </Text>
                    </Pressable>
                    <Pressable onPress={() => setMenuScheduleId(schedule.id)} hitSlop={10}>
                      <Text style={[styles.menuLabel, { color: colors.textSecondary }]}>...</Text>
                    </Pressable>
                  </View>
                </View>

                <Text style={[styles.cardSummary, { color: colors.textSecondary }]}>
                  {summary}
                </Text>

                <View style={styles.messageBlock}>
                  <Text style={[styles.messageLabel, { color: colors.label }]}>Message</Text>
                  <TextInput
                    value={schedule.message}
                    onChangeText={(text) => updateSchedule(schedule.id, { message: text })}
                    placeholder={DEFAULT_MESSAGE}
                    placeholderTextColor={colors.placeholder}
                    style={[
                      styles.messageInput,
                      {
                        backgroundColor: colors.inputBackground,
                        color: colors.inputText,
                        borderColor: colors.border,
                      },
                    ]}
                    maxLength={120}
                    clearButtonMode="while-editing"
                    returnKeyType="done"
                    onSubmitEditing={Keyboard.dismiss}
                  />
                </View>
                <View style={styles.cardActionRow}>
                  <Pressable
                    style={[
                      styles.testButton,
                      { borderColor: colors.border, backgroundColor: colors.inputBackground },
                    ]}
                    onPress={() => void sendTestNotification(schedule, index)}
                    accessibilityRole="button"
                    accessibilityLabel={`Send test notification for ${scheduleDisplayName}`}
                  >
                    <Text style={[styles.testButtonLabel, { color: colors.textPrimary }]}>
                      Test notification
                    </Text>
                  </Pressable>
                </View>

                {!isCollapsed ? (
                  <>
                    <View style={[styles.divider, { backgroundColor: colors.border }]} />

                    <View
                      style={[
                        styles.intervalRow,
                        { backgroundColor: colors.inputBackground, borderColor: colors.border },
                      ]}
                    >
                      <Pressable
                        style={[
                          styles.stepperButton,
                          { backgroundColor: colors.accent, borderColor: colors.accent },
                        ]}
                        onPress={() => stepInterval(schedule.id, -1)}
                      >
                        <Text style={styles.stepperLabel}>-</Text>
                      </Pressable>
                      <View style={styles.intervalInputGroup}>
                        <TextInput
                          value={intervalDrafts[schedule.id] ?? String(schedule.intervalMinutes)}
                          onChangeText={(value) => updateIntervalDraft(schedule.id, value)}
                          onBlur={() => commitIntervalDraft(schedule.id)}
                          onSubmitEditing={() => commitIntervalDraft(schedule.id)}
                          keyboardType="number-pad"
                          returnKeyType="done"
                          style={[
                            styles.intervalInput,
                            { color: colors.textPrimary, borderColor: colors.border },
                          ]}
                        />
                        <Text style={[styles.intervalUnit, { color: colors.textSecondary }]}>
                          min
                        </Text>
                      </View>
                      <Pressable
                        style={[
                          styles.stepperButton,
                          { backgroundColor: colors.accent, borderColor: colors.accent },
                        ]}
                        onPress={() => stepInterval(schedule.id, 1)}
                      >
                        <Text style={styles.stepperLabel}>+</Text>
                      </Pressable>
                    </View>

                    <Pressable
                      style={[
                        styles.timeRow,
                        { backgroundColor: colors.inputBackground, borderColor: colors.border },
                      ]}
                      onPress={() =>
                        setActivePicker({ scheduleId: schedule.id, kind: 'start' })
                      }
                    >
                      <Text style={[styles.timeLabel, { color: colors.label }]}>Start</Text>
                      <Text style={[styles.timeValue, { color: colors.textPrimary }]}>
                        {startLabel}
                      </Text>
                    </Pressable>

                    <Pressable
                      style={[
                        styles.timeRow,
                        { backgroundColor: colors.inputBackground, borderColor: colors.border },
                      ]}
                      onPress={() => setActivePicker({ scheduleId: schedule.id, kind: 'end' })}
                    >
                      <Text style={[styles.timeLabel, { color: colors.label }]}>End</Text>
                      <Text style={[styles.timeValue, { color: colors.textPrimary }]}>
                        {endLabel}
                      </Text>
                    </Pressable>

                    <View style={styles.dayRow}>
                      {DAY_LABELS.map((label, dayIndex) => {
                        const isSelected = daysOfWeek[dayIndex];
                        return (
                          <Pressable
                            key={`${schedule.id}-${label}`}
                            style={[
                              styles.dayButton,
                              {
                                backgroundColor: isSelected ? colors.accent : colors.inputBackground,
                                borderColor: isSelected ? colors.accent : colors.border,
                              },
                            ]}
                            onPress={() => toggleScheduleDay(schedule.id, dayIndex)}
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

                    {isOvernight ? (
                      <Text style={[styles.helperText, { color: colors.textMuted }]}>
                        Overnight window. Alerts after midnight count as the next day. Example:
                        Mon 9:00 PM - 6:00 AM needs Tue selected for after-midnight alerts.
                      </Text>
                    ) : null}

                  </>
                ) : null}
              </View>
            );
          })}

        </ScrollView>
      </KeyboardAvoidingView>
      ) : (
        <ScrollView
          style={styles.scroll}
          contentContainerStyle={[styles.settingsContainer, { backgroundColor: colors.background }]}
          contentInsetAdjustmentBehavior="always"
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
        >
          <Text style={[styles.title, { color: colors.textPrimary }]}>Settings</Text>
          <View
            style={[
              styles.card,
              {
                backgroundColor: colors.card,
                shadowColor: colors.shadow,
                borderColor: colors.border,
              },
            ]}
          >
            <View style={styles.settingsRow}>
              <View style={styles.settingsText}>
                <Text style={[styles.settingsLabel, { color: colors.textPrimary }]}>Dark mode</Text>
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
                backgroundColor: colors.card,
                shadowColor: colors.shadow,
                borderColor: colors.border,
              },
            ]}
          >
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
        </ScrollView>
      )}

      <View
        style={[
          styles.tabBar,
          {
            backgroundColor: colors.card,
            borderColor: colors.border,
            height: TAB_BAR_HEIGHT + insets.bottom,
            paddingBottom: insets.bottom,
          },
        ]}
      >
        <Pressable
          onPress={() => setActiveTab('home')}
          style={styles.tabButton}
          accessibilityRole="button"
          accessibilityState={{ selected: activeTab === 'home' }}
        >
          <MaterialIcons
            name="home"
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
            Home
          </Text>
        </Pressable>
        <Pressable
          onPress={() => setActiveTab('settings')}
          style={styles.tabButton}
          accessibilityRole="button"
          accessibilityState={{ selected: activeTab === 'settings' }}
        >
          <MaterialIcons
            name="settings"
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

      {isNamePromptOpen ? (
        <View style={[styles.sheetBackdrop, { backgroundColor: colors.sheetBackdrop }]}>
          <Animated.View
            style={[
              styles.namePromptWrapper,
              { transform: [{ translateY: Animated.multiply(keyboardOffset, -1) }] },
            ]}
          >
            <View
              style={[
                styles.namePrompt,
                {
                  backgroundColor: colors.sheet,
                  borderColor: colors.border,
                  shadowColor: colors.shadow,
                },
              ]}
            >
              <Text style={[styles.namePromptTitle, { color: colors.textPrimary }]}>
                {namePromptTitle}
              </Text>
              <TextInput
                value={nameDraft}
                onChangeText={setNameDraft}
                placeholder={namePromptPlaceholder}
                placeholderTextColor={colors.placeholder}
                style={[
                  styles.namePromptInput,
                  {
                    backgroundColor: colors.inputBackground,
                    color: colors.inputText,
                    borderColor: colors.border,
                  },
                ]}
                autoCapitalize="words"
                autoFocus
                maxLength={40}
                returnKeyType="done"
                onSubmitEditing={confirmNamePrompt}
              />
              <View style={styles.namePromptActions}>
                <Pressable onPress={closeNamePrompt} hitSlop={8}>
                  <Text style={[styles.namePromptCancel, { color: colors.textSecondary }]}>
                    Cancel
                  </Text>
                </Pressable>
                <Pressable
                  onPress={confirmNamePrompt}
                  disabled={!canConfirmName}
                  style={[
                    styles.namePromptButton,
                    { backgroundColor: canConfirmName ? colors.accent : colors.placeholder },
                  ]}
                >
                  <Text style={styles.namePromptButtonLabel}>
                    {isEditingName ? 'Save' : 'Add'}
                  </Text>
                </Pressable>
              </View>
            </View>
          </Animated.View>
        </View>
      ) : null}

      {activeTab === 'home' && menuScheduleId ? (
        <View style={[styles.sheetBackdrop, { backgroundColor: colors.sheetBackdrop }]}>
          <Pressable style={StyleSheet.absoluteFillObject} onPress={closeMenu} />
          <View
            style={[
              styles.menuSheet,
              {
                backgroundColor: colors.sheet,
                borderColor: colors.border,
                shadowColor: colors.shadow,
              },
            ]}
          >
            <Pressable
              style={styles.menuItem}
              onPress={() => {
                const schedule = schedules.find((item) => item.id === menuScheduleId);
                closeMenu();
                if (schedule) {
                  editScheduleName(schedule);
                }
              }}
            >
              <View style={styles.menuItemContent}>
                <MaterialIcons name="edit" size={18} color={colors.textPrimary} />
                <Text style={[styles.menuItemText, { color: colors.textPrimary }]}>Edit</Text>
              </View>
            </Pressable>
            <Pressable
              style={styles.menuItem}
              onPress={() => {
                const schedule = schedules.find((item) => item.id === menuScheduleId);
                closeMenu();
                if (schedule) {
                  duplicateSchedule(schedule);
                }
              }}
            >
              <View style={styles.menuItemContent}>
                <MaterialIcons name="content-copy" size={18} color={colors.textPrimary} />
                <Text style={[styles.menuItemText, { color: colors.textPrimary }]}>Duplicate</Text>
              </View>
            </Pressable>
            <Pressable
              style={styles.menuItem}
              onPress={() => {
                const schedule = schedules.find((item) => item.id === menuScheduleId);
                closeMenu();
                if (schedule) {
                  void removeSchedule(schedule.id);
                }
              }}
            >
              <View style={styles.menuItemContent}>
                <MaterialIcons name="delete-outline" size={18} color={colors.remove} />
                <Text style={[styles.menuItemText, { color: colors.remove }]}>Remove</Text>
              </View>
            </Pressable>
            <Pressable style={styles.menuCancel} onPress={closeMenu}>
              <View style={styles.menuCancelContent}>
                <MaterialIcons name="close" size={18} color={colors.textSecondary} />
                <Text style={[styles.menuCancelText, { color: colors.textSecondary }]}>
                  Cancel
                </Text>
              </View>
            </Pressable>
          </View>
        </View>
      ) : null}

      {activePicker && (activeSchedule || activePicker.scheduleId === 'quiet') ? (
        <View style={[styles.sheetBackdrop, { backgroundColor: colors.sheetBackdrop }]}>
          <View style={[styles.sheet, { backgroundColor: colors.sheet }]}>
            <View style={styles.sheetHeader}>
              <Text style={[styles.sheetTitle, { color: colors.textPrimary }]}>
                {activePicker.scheduleId === 'quiet'
                  ? activePicker.kind === 'start'
                    ? 'Quiet hours start'
                    : 'Quiet hours end'
                  : activePicker.kind === 'start'
                    ? 'Start time'
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
              { backgroundColor: colors.card, borderColor: colors.border, shadowColor: colors.shadow },
            ]}
          >
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
    <SafeAreaProvider>
      <ColorSchemeProvider>
        <AppContent />
      </ColorSchemeProvider>
    </SafeAreaProvider>
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
    paddingBottom: 220,
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
    fontSize: 16,
    fontWeight: '600',
    fontFamily: FONT_BOLD,
  },
  settingsHelper: {
    fontSize: 13,
  },
  settingsSectionTitle: {
    fontSize: 15,
    fontWeight: '700',
    fontFamily: FONT_BOLD,
  },
  scroll: {
    flex: 1,
  },
  title: {
    fontSize: 34,
    fontWeight: '800',
    fontFamily: FONT_BOLD,
    letterSpacing: -0.5,
  },
  titleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  addButton: {
    width: 40,
    height: 40,
    borderRadius: 20,
    borderWidth: 0,
    alignItems: 'center',
    justifyContent: 'center',
    shadowOpacity: 0.15,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 2 },
    elevation: 4,
  },
  card: {
    borderRadius: 20,
    padding: 20,
    gap: 16,
    borderWidth: 1,
    shadowOpacity: 0.08,
    shadowRadius: 20,
    shadowOffset: { width: 0, height: 4 },
    elevation: 8,
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
    fontSize: 17,
    fontWeight: '600',
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
    fontSize: 20,
    fontWeight: '600',
    fontFamily: FONT_BOLD,
    letterSpacing: 1,
  },
  cardSummary: {
    fontSize: 12,
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
    fontSize: 12,
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
    fontSize: 12,
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
    fontSize: 16,
    fontWeight: '600',
    fontFamily: FONT_MEDIUM,
  },
  intervalUnit: {
    fontSize: 13,
    fontWeight: '600',
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
    fontSize: 20,
    color: '#FFFFFF',
    fontWeight: '700',
    fontFamily: FONT_BOLD,
  },
  intervalValue: {
    fontSize: 16,
    fontWeight: '600',
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
    fontSize: 15,
    fontWeight: '600',
    fontFamily: FONT_MEDIUM,
  },
  timeValue: {
    fontSize: 15,
    fontWeight: '600',
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
    fontSize: 11,
    fontWeight: '600',
    fontFamily: FONT_BOLD,
  },
  helperText: {
    fontSize: 12,
    fontFamily: FONT_REGULAR,
  },
  messageBlock: {
    gap: 6,
  },
  messageLabel: {
    fontSize: 12,
    fontWeight: '600',
    fontFamily: FONT_MEDIUM,
  },
  messageInput: {
    borderRadius: 14,
    paddingHorizontal: 16,
    paddingVertical: 12,
    fontSize: 15,
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
    fontSize: 15,
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
    fontSize: 15,
    fontWeight: '700',
    fontFamily: FONT_BOLD,
  },
  namePrompt: {
    marginHorizontal: 18,
    padding: 24,
    borderRadius: 24,
    borderWidth: 0,
    shadowOpacity: 0.15,
    shadowRadius: 20,
    shadowOffset: { width: 0, height: 8 },
    gap: 16,
    elevation: 10,
  },
  namePromptTitle: {
    fontSize: 17,
    fontWeight: '700',
    fontFamily: FONT_BOLD,
  },
  namePromptInput: {
    borderRadius: 14,
    paddingHorizontal: 16,
    paddingVertical: 12,
    fontSize: 16,
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
    fontSize: 15,
    fontWeight: '600',
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
    fontSize: 15,
    fontWeight: '700',
    fontFamily: FONT_BOLD,
  },
  menuSheet: {
    marginHorizontal: 18,
    marginBottom: 18,
    borderRadius: 24,
    borderWidth: 0,
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
    fontSize: 16,
    fontWeight: '600',
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
    fontSize: 15,
    fontWeight: '600',
    fontFamily: FONT_BOLD,
    textAlign: 'center',
  },
  mapPickerCard: {
    marginHorizontal: 18,
    marginBottom: 24,
    borderRadius: 18,
    borderWidth: 1,
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
    fontSize: 17,
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
  onboardingBackdrop: {
    ...StyleSheet.absoluteFillObject,
    justifyContent: 'center',
    padding: 24,
  },
  onboardingCard: {
    borderRadius: 18,
    borderWidth: 1,
    padding: 18,
    gap: 12,
    shadowOpacity: 0.06,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 8 },
  },
  onboardingTitle: {
    fontSize: 20,
    fontWeight: '700',
    fontFamily: FONT_BOLD,
  },
  onboardingText: {
    fontSize: 13,
    lineHeight: 18,
  },
  onboardingButton: {
    borderRadius: 12,
    paddingVertical: 10,
    alignItems: 'center',
    borderWidth: 1,
  },
  onboardingButtonLabel: {
    color: '#FFFFFF',
    fontSize: 14,
    fontWeight: '700',
    fontFamily: FONT_BOLD,
  },
  sheet: {
    paddingTop: 12,
    paddingHorizontal: 16,
    paddingBottom: 24,
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
  },
  sheetHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingBottom: 8,
  },
  sheetTitle: {
    fontSize: 16,
    fontWeight: '600',
  },
  sheetDone: {
    fontSize: 16,
    fontWeight: '600',
  },
  tabBar: {
    flexDirection: 'row',
    borderTopWidth: 0,
    height: TAB_BAR_HEIGHT,
    shadowOpacity: 0.08,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: -4 },
    elevation: 8,
  },
  tabButton: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 4,
    paddingTop: 20,
    paddingBottom: 0,
  },
  tabIcon: {
    height: 25,
    marginTop: 6,
  },
  tabLabel: {
    fontSize: 12,
    fontWeight: '600',
    fontFamily: FONT_MEDIUM,
  },
});

const lightColors = {
  background: '#F0F4EF',
  card: '#FAFDF9',
  textPrimary: '#1C2B1A',
  textSecondary: '#4A5F47',
  textMuted: '#7A8F77',
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
  background: '#000000',
  card: '#16181C',
  textPrimary: '#E7E9EA',
  textSecondary: '#71767B',
  textMuted: '#536471',
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
  border: '#2F3336',
};

