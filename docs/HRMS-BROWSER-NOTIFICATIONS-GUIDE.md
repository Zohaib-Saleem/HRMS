# Browser notifications

Browser notifications are an extra way of telling you about something HRMS has already put in your
bell. They are never the only way. Every notification is written to the bell first. A browser
notification is then sent to each browser where you have turned them on. If the browser is closed,
blocked or turned off, you lose only the pop-up; the bell still has everything.

## Turning them on

1. Open **My profile** and find **Notification settings**.
2. Press **Enable notifications**. Your browser asks whether HRMS may show notifications; choose
   **Allow**.
3. Press **Send test notification**. A notification titled "HRMS notifications are on" should
   appear within a few seconds. It also appears in your bell.

HRMS never asks for permission when you sign in. It asks only when you press the button.

Each browser is set up separately. Turning notifications on at your desk does not turn them on on
your phone. Do it once on each device you want them on.

### What the card shows

| Line | Meaning |
|---|---|
| Browser notifications | Whether *this* browser is set up to receive them. |
| Permission | What your browser has decided for this site: **Allowed**, **Blocked**, **Not asked yet**, or **Not available** (the browser cannot do it). |
| Last delivery to this browser | When the push service last accepted a notification for this browser, or the code of the last failure. "Accepted" means it reached the push service. Whether the device was on and showed it is not reported back. |
| Other browsers | Your other devices, each with a **Turn off** button. |

## Choosing what you are told about

Under **Send browser notifications for**, untick any category you do not want pop-ups for:

| Category | Covers |
|---|---|
| Cases and IT issues | cases assigned to you or put on your desk's queue, replies, status and priority changes, reassignments |
| Attendance and corrections | correction requests waiting for you, shift changes and timesheets, and the decision on your own |
| Leave and approvals | leave requests waiting for you, and the decision on your own |
| Assets | an asset issued to you to confirm, an asset issue reported (for IT), your equipment requests |
| Payroll and salary advances | your payslip is published, a salary advance or loan decided or released, a payroll run ready to approve |
| Everything else | greetings, interviews, medical claims and anything not listed above |

Unticking a category stops only the pop-up. The notification still appears in your bell. The
choice applies to every browser you have turned on. The test notification is always sent.

## What a notification says, and what it leaves out

A notification can appear on a locked screen where other people can see it, so it says less than
the bell does.

- **Never shown:** money amounts (payslips, loans, advances), anything about medical claims, a
  case's subject, an interview candidate's name, an approver's comment, or the reason given on an
  attendance correction.
- **Shown:** who is asking and for what. For example: "Hassan Ali — 5 Oct 2026 — Check-out
  correction requested for 06:02 PM", "Hira Javed requested Casual Leave: 2026-10-06 to
  2026-10-06 (1 day)", or "DXT-GE-013 — Dell Latitude 5420 reported: Not working".
- Cases show only their number and what happened, such as "Case CASE-2026-000020 assigned to
  you". Open it to read the rest.

## Clicking a notification

Clicking a notification brings your HRMS tab to the front, or opens one, and goes to the case,
request or record it is about. If you are not signed in, you sign in first and then land there.

HRMS checks the notification against the account signed in on that browser. If it belongs to
someone else, you see **This notification is not available**. The screen it leads to still checks
your access. If you can no longer open the record, you see that screen's normal "no access" message.

## Signing out

Signing out turns notifications off in that browser, so the next person to use it does not receive
yours. Turn them back on from your profile after you sign in again.

## Supported browsers

| Browser | Works? | Notes |
|---|---|---|
| Chrome, Edge (Windows, macOS, Linux) | Yes | Notifications arrive while the browser is running, including in the background. |
| Firefox (desktop) | Yes | The same. |
| Safari on macOS 13 (Ventura) or later | Yes | Safari 16 or later. |
| Chrome or Firefox on Android | Yes | |
| **iPhone and iPad** | Only from the Home Screen | Needs iOS / iPadOS 16.4 or later. See below. |
| Older browsers, or HRMS opened over plain `http://` | No | The card says why. Use the bell. |

### iPhone and iPad

Apple allows web notifications only for a site added to the Home Screen and opened from there. They
do not work in an ordinary Safari tab, or in Chrome or Firefox on iOS.

1. Open HRMS in **Safari**.
2. Tap **Share**, then **Add to Home Screen**.
3. Open HRMS from the new Home Screen icon and sign in.
4. Go to **My profile → Notification settings** and press **Enable notifications**.

If the card says "On iPhone and iPad, notifications work only from the Home Screen app", you are in
a Safari tab rather than the Home Screen app.

## When they do not arrive

| What you see | What to do |
|---|---|
| Permission **Blocked** | You, or the browser, refused earlier. HRMS will not ask again. Click the icon to the left of the address bar, open the site settings, set **Notifications** to **Allow**, and reload. |
| "Browser notifications have not been set up on this server yet" | The server has no notification keys. Ask your administrator; see the admin manual, §19. |
| Card shows **Enabled** but nothing pops up | Check the operating system: Windows *Focus assist* / *Do not disturb*, macOS *Focus*, or the browser's own notification setting in system settings. |
| "This browser's registration stopped working" | The push service retired this browser's registration. Press **Enable notifications** again. |
| A device listed as **Expired** | That browser will register itself again the next time you open HRMS there. If it does not, enable it again on that device. |

## What is not here

- No notifications by email or SMS from this feature. Email is a separate setting the administrator
  controls.
- No per-notification choices, and no quiet hours. Use the categories, or your device's own
  do-not-disturb setting.
- A notification that has not been delivered within 24 hours is not sent. By then it is in your
  bell, and a day-old pop-up is noise.
