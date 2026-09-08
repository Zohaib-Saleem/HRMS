# Running the connector on Windows

The connector is one file and needs Node 20 or later. There is no installer,
because there is nothing to install: the whole program is `hrms-connector.mjs`
and the JSON file beside it.

## 1. Put it somewhere permanent

```
C:\hrms-connector\hrms-connector.mjs
C:\hrms-connector\connector.config.json
```

Not the Desktop, and not a user profile folder — a service runs as a different
account and will not find it there.

## 2. Check it works before making it a service

```
cd C:\hrms-connector
node hrms-connector.mjs
```

Within a few seconds you should see `HANDSHAKE`, then `ROSTER_SENT`, then
either `BATCH_SENT` or `NOTHING_NEW`. Anything else names its own problem —
see the troubleshooting table in `../README.md`. Press Ctrl+C to stop.

Do not skip this step. Diagnosing a service that will not start is far harder
than diagnosing a program that prints its reason and exits.

## 3. Run it as a service

Windows has no native way to supervise a plain executable, so use **NSSM**
(<https://nssm.cc>), which is a small open-source service wrapper:

```
nssm install HRMSConnector "C:\Program Files\nodejs\node.exe" "C:\hrms-connector\hrms-connector.mjs"
nssm set HRMSConnector AppDirectory C:\hrms-connector
nssm set HRMSConnector AppStdout C:\hrms-connector\connector.log
nssm set HRMSConnector AppStderr C:\hrms-connector\connector.log
nssm set HRMSConnector AppRotateFiles 1
nssm start HRMSConnector
```

**Task Scheduler is not a substitute.** A scheduled task set to "run at logon"
stops when the person logs off, and attendance stops with it — usually
discovered a fortnight later, at payroll.

## 4. Confirm it survives a reboot

Restart the machine and check `connector.log` gains new lines without anyone
signing in. This is the only test that matters: an office PC is rebooted by
Windows Update on a schedule nobody controls.

## Notes

- The connector needs outbound HTTPS to the HRMS and TCP to the terminal on
  the LAN (port 4370 by default). It listens on nothing, so no inbound
  firewall rule is required, and none should be added.
- If the machine sleeps, the connector sleeps. On a desktop that is left on,
  set the power plan to never sleep; on a laptop, use a different machine.
