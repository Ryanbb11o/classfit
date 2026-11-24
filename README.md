# Classfit website

Website for Classfit gym, Varna, with member accounts and a front desk check-in page.

## Run

Needs Node 22.13 or newer. No packages to install.

```
node server.js
```

Then open:

- http://localhost:3000 – public site
- http://localhost:3000/account.html – member sign up, log in, profile and QR code
- http://localhost:3000/desk.html – front desk and list of all members
- http://localhost:3000/trainer.html – trainers: scan or pick a member, mark a visit, edit details and notes
- http://localhost:3000/reset.html – forgot password

## Front desk and trainer access

**For now the front desk and trainer pages are open to everyone** (no PIN), so anyone with the link can see all member details and change subscriptions. Lock it before going live by setting a PIN:

```
$env:STAFF_PIN = "your-pin"; node server.js
```

## Passwords and email

- Passwords need at least 10 characters, an upper and a lower case letter and a digit, and can't contain the email name.
- "Reset password" emails a link that works for 60 minutes. Using it logs the member out everywhere.
- **No email provider is connected yet.** Emails are saved as text files in `data/outbox/` and printed in the server log. Connect a provider (SMTP, Resend, Mailgun…) in `sendMail()` in `server.js` and set `SITE_URL` to the site's address before going live.

## Trainer page

- Scan a member (camera, handheld scanner, or type number, phone or email) or pick one from the list. Looking someone up does not log a visit.
- "Mark visit" logs a visit with the trainer's name (remembered on that device). If the member was already marked today, at the desk or by a trainer, the page says so first.
- Trainers can edit name, phone, email and private trainer notes (goals, injuries, program). Members don't see the notes.
- Each visit shows where it came from: front desk or trainer.

## Guest sign-in

"Continue as guest" on the account page opens a shared demo profile (`CF-000000`) with sample data. It can't be changed, doesn't appear in the front desk list, and its QR code is refused at the desk.

## How check-in works

1. A member signs up and gets a member number like `CF-123456`. Their profile shows it as a QR code.
2. At the desk, staff scan the QR code with the camera, a handheld scanner, or type the number, phone or email.
3. The desk shows green (ACTIVE, with end date) or red (NO SUBSCRIPTION) and logs the check-in.
4. Staff add time with +1 day / +1 / +3 / +12 months, or stop a subscription.

The QR code holds only the member number, so staff should check the name on screen matches the person.

## Data

Stored in `data/classfit.db` (SQLite). Delete the `data` folder to start empty.

## Files

- `server.js` – web server and API
- `public/index.html` – home page
- `public/account.html` – member accounts
- `public/desk.html` – front desk
- `public/site.css`, `public/i18n.js` – shared styles and language switch
- `public/nav.js` – shared header: profile icon and three-line menu
- `public/trainer.html`, `public/scanner.js` – trainer page and camera QR scanner
- `public/reset.html` – forgot / reset password

## Photo

Photos in `public/img/` are Classfit's own, uploaded by the Classfit account to Google Maps (March 2025).
The image files are marked "KOLEV PHOTOGRAPHY", so check with the gym that the photographer allows web use.

- `gym-floor.jpg` – main floor (home page background and gallery)
- `gym-functional.jpg` – functional zone
- `gym-cardio.jpg` – cardio zone
