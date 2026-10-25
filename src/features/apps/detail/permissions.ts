import {
  Activity,
  Bell,
  Bluetooth,
  Camera,
  Contact,
  type LucideIcon,
  MapPin,
  Phone,
  Shield,
} from "lucide-react";

import type { PermissionState } from "../api";

export type PermissionGroup =
  | "cameraMic"
  | "location"
  | "notificationsMedia"
  | "contactsCalendar"
  | "phoneSms"
  | "nearby"
  | "body"
  | "other";

export const GROUP_ICONS: Record<PermissionGroup, LucideIcon> = {
  cameraMic: Camera,
  location: MapPin,
  notificationsMedia: Bell,
  contactsCalendar: Contact,
  phoneSms: Phone,
  nearby: Bluetooth,
  body: Activity,
  other: Shield,
};

export const GROUP_ORDER: PermissionGroup[] = [
  "cameraMic",
  "location",
  "notificationsMedia",
  "contactsCalendar",
  "phoneSms",
  "nearby",
  "body",
  "other",
];

const GROUPS: Record<string, PermissionGroup> = {
  CAMERA: "cameraMic",
  RECORD_AUDIO: "cameraMic",
  ACCESS_FINE_LOCATION: "location",
  ACCESS_COARSE_LOCATION: "location",
  ACCESS_BACKGROUND_LOCATION: "location",
  ACCESS_MEDIA_LOCATION: "location",
  POST_NOTIFICATIONS: "notificationsMedia",
  READ_MEDIA_IMAGES: "notificationsMedia",
  READ_MEDIA_VIDEO: "notificationsMedia",
  READ_MEDIA_AUDIO: "notificationsMedia",
  READ_MEDIA_VISUAL_USER_SELECTED: "notificationsMedia",
  READ_EXTERNAL_STORAGE: "notificationsMedia",
  WRITE_EXTERNAL_STORAGE: "notificationsMedia",
  READ_CONTACTS: "contactsCalendar",
  WRITE_CONTACTS: "contactsCalendar",
  GET_ACCOUNTS: "contactsCalendar",
  READ_CALENDAR: "contactsCalendar",
  WRITE_CALENDAR: "contactsCalendar",
  READ_PHONE_STATE: "phoneSms",
  READ_PHONE_NUMBERS: "phoneSms",
  CALL_PHONE: "phoneSms",
  ANSWER_PHONE_CALLS: "phoneSms",
  READ_CALL_LOG: "phoneSms",
  WRITE_CALL_LOG: "phoneSms",
  ADD_VOICEMAIL: "phoneSms",
  USE_SIP: "phoneSms",
  PROCESS_OUTGOING_CALLS: "phoneSms",
  ACCEPT_HANDOVER: "phoneSms",
  SEND_SMS: "phoneSms",
  RECEIVE_SMS: "phoneSms",
  READ_SMS: "phoneSms",
  RECEIVE_MMS: "phoneSms",
  RECEIVE_WAP_PUSH: "phoneSms",
  READ_CELL_BROADCASTS: "phoneSms",
  BLUETOOTH_SCAN: "nearby",
  BLUETOOTH_CONNECT: "nearby",
  BLUETOOTH_ADVERTISE: "nearby",
  NEARBY_WIFI_DEVICES: "nearby",
  UWB_RANGING: "nearby",
  RANGING: "nearby",
  BODY_SENSORS: "body",
  BODY_SENSORS_BACKGROUND: "body",
  ACTIVITY_RECOGNITION: "body",
  READ_HEART_RATE: "body",
  READ_SKIN_TEMPERATURE: "body",
  READ_OXYGEN_SATURATION: "body",
};

/** `android.permission.CAMERA` → `CAMERA`. */
export function shortPermission(name: string) {
  return name.startsWith("android.permission.")
    ? name.slice("android.permission.".length)
    : name;
}

export function groupOf(name: string): PermissionGroup {
  return (
    (name.startsWith("android.permission.")
      ? GROUPS[shortPermission(name)]
      : undefined) ?? "other"
  );
}

/** `READ_MEDIA_AUDIO` → "Read media audio" when no translation exists. */
export function humanize(name: string) {
  const short = shortPermission(name).split(".").pop() ?? name;
  const words = short.toLowerCase().split("_").filter(Boolean).join(" ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

export const isFixed = (p: PermissionState) =>
  p.flags.some((f) => f === "SYSTEM_FIXED" || f === "POLICY_FIXED");

export const isModified = (p: PermissionState) =>
  p.flags.some((f) => f === "USER_SET" || f === "USER_FIXED");

/** Requested permissions governed by an app-op ("special app access"). */
export const SPECIAL: Record<string, string> = {
  "android.permission.SYSTEM_ALERT_WINDOW": "SYSTEM_ALERT_WINDOW",
  "android.permission.WRITE_SETTINGS": "WRITE_SETTINGS",
  "android.permission.MANAGE_EXTERNAL_STORAGE": "MANAGE_EXTERNAL_STORAGE",
  "android.permission.REQUEST_INSTALL_PACKAGES": "REQUEST_INSTALL_PACKAGES",
  "android.permission.PACKAGE_USAGE_STATS": "GET_USAGE_STATS",
  "android.permission.SCHEDULE_EXACT_ALARM": "SCHEDULE_EXACT_ALARM",
  "android.permission.USE_FULL_SCREEN_INTENT": "USE_FULL_SCREEN_INTENT",
  "android.permission.MANAGE_MEDIA": "MANAGE_MEDIA",
  "android.permission.REQUEST_DELETE_PACKAGES": "REQUEST_DELETE_PACKAGES",
};
