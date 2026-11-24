# Classfit website

Website for Classfit gym, Varna, with member accounts, a front desk check-in page and a trainer page.
Logins and data are in Supabase (project **classfit**, region eu-central-1).

## Run

Needs Node 22.13 or newer. No packages to install.

1. Create a file called `.env` next to `server.js` (it is never committed):

   ```
   SUPABASE_URL=https://incfgjmzmxssotiqqjqz.supabase.co
   SUPABASE_ANON_KEY=<publishable key>
   SUPABASE_SERVICE_ROLE_KEY=<service_role key (legacy JWT)>
   COOKIE_SECRET=<any long random text>
   ```

   The keys are in the Supabase dashboard under Project Settings → API Keys, or:
   `npx.cmd supabase projects api-keys --project-ref incfgjmzmxssotiqqjqz`.
   The service_role key gives full access to the database: keep it on the server only.

2. Start the server:

   ```
   node server.js
   ```

Then open:

- http://localhost:3000 – public site
- http://localhost:3000/account.html – member sign up, log in, profile and QR code
- http://localhost:3000/desk.html – front desk and list of all members
- http://localhost:3000/trainer.html – trainers: scan or pick a member, mark a visit, edit details and notes
- http://localhost:3000/reset.html – forgot password

## How it fits together

- **Logins** use Supabase Auth in the browser (`supabase-js`). Pages send the member's login token to this server, which checks it with Supabase.
- **Data** is in Supabase Postgres: `members` and `checkins`. Row level security is on and the browser roles have no access; only this server (service_role key) reads and writes them.
- When someone signs up, a database trigger creates their `members` row with a member number (`CF-123456`) and a free first visit.
- Visits are logged by the `log_visit()` database function, which also spends the free visit when that's what lets the member in.
- The database setup is in `supabase/migrations/`. Login settings are in `supabase/config.jsonc` (push changes with `npx.cmd supabase config push`).

## Front desk and trainer access

**For now the front desk and trainer pages are open to everyone** (no PIN), so anyone with the link can see all member details and change subscriptions. Lock them before going live by adding a PIN to `.env`:

```
STAFF_PIN=your-pin
```

## Passwords and email

- Supabase requires passwords of at least 10 characters with an upper and a lower case letter and a digit. The page also rejects passwords that contain the email name.
- Sign-up logs the member in straight away: email confirmation is turned off.
- "Reset password" sends a Supabase email with a link back to `reset.html`. Setting a new password logs the member out everywhere.
- **Supabase's built-in email only sends to members of the Supabase project team, and only a few emails an hour.** Before going live, add your own SMTP provider in the Supabase dashboard (Authentication → Emails → SMTP settings). Then you can also turn email confirmation back on.
- When the site has its real address, add it in Supabase as the Site URL and to the redirect URLs (`supabase/config.jsonc`, `auth.site_url` and `auth.additional_redirect_urls`).

## Trainer page

- Scan a member (camera, handheld scanner, or type number, phone or email) or pick one from the list. Looking someone up does not log a visit.
- "Mark visit" logs a visit with the trainer's name (remembered on that device). If the member was already marked today, at the desk or by a trainer, the page says so first.
- Trainers can edit name, phone, email and private trainer notes (goals, injuries, program). Changing the email also changes the member's login email. Members don't see the notes.
- Each visit shows where it came from: front desk or trainer.

## Free first visit offer

- Everyone who signs up gets one free visit. It's valid until closing (21:00) today, or until 21:00 tomorrow if they sign up at 18:00 or later (Sofia time). The hour is set in the database function `trial_end_date()` and, for the countdown on the website, `TRIAL_LATE_HOUR` in `server.js`: change both together.
- The home page shows the offer with a live countdown, and "Claim your free visit" opens the sign-up form.
- The member's profile shows the free visit with a countdown until it expires.
- It's used up by the first scan at the front desk or the first visit a trainer marks, as long as the member has no subscription. The desk shows "FREE VISIT" in green, and the visit is labelled as free everywhere.
- The guest demo account doesn't get one.

## Guest sign-in

"Continue as guest" on the account page opens a shared demo profile (`CF-000000`) with sample data. It isn't a Supabase login: the server gives the browser a signed cookie for 4 hours. It can't be changed, doesn't appear in the front desk list, and its QR code is refused at the desk.

## How check-in works

1. A member signs up and gets a member number like `CF-123456`. Their profile shows it as a QR code.
2. At the desk, staff scan the QR code with the camera, a handheld scanner, or type the number, phone or email.
3. The desk shows green (ACTIVE, with end date) or red (NO SUBSCRIPTION) and logs the check-in.
4. Staff add time with +1 day / +1 / +3 / +12 months, or stop a subscription.

The QR code holds only the member number, so staff should check the name on screen matches the person.

## Files

- `server.js` – web server and API
- `supabase/migrations/` – database tables, triggers and functions
- `supabase/config.jsonc` – Supabase login settings
- `public/index.html` – home page
- `public/account.html` – member accounts
- `public/desk.html` – front desk
- `public/trainer.html`, `public/scanner.js` – trainer page and camera QR scanner
- `public/reset.html` – forgot / reset password
- `public/site.css`, `public/i18n.js` – shared styles, language switch and Supabase client
- `public/nav.js` – shared header: profile icon and three-line menu

## Photos

Photos in `public/img/` are Classfit's own, uploaded by the Classfit account to Google Maps (March 2025).
The image files are marked "KOLEV PHOTOGRAPHY", so check with the gym that the photographer allows web use.

- `gym-floor.jpg` – main floor (home page background and gallery)
- `gym-functional.jpg` – functional zone
- `gym-cardio.jpg` – cardio zone
