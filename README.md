# Leave Tracker — Kosovo 🇽🇰

A time-off tracker for small teams that combines a **QuickBooks-style accrual engine** with the statutory rules of the **Kosovo Labour Law (Law No. 03/L-212)**. Built with React + Vite, styled after the Stripe design system. Data is stored locally in the browser (no backend required).

## Features

**QuickBooks-style engine**
- Five time-off types: Paid time off, Annual leave, Sick pay, Holiday pay, Unpaid time off
- Four accrual methods per policy: at beginning of year, on anniversary date, each pay period, per hour worked
- Hours-based balances with day equivalents, maximum balance caps, opening balances, carryover rules, unlimited policies, and negative-balance warnings

**Kosovo Labour Law rules**
- Statutory entitlement calculator: 20-working-day base (30 for harmful/difficult conditions), +1 day per 5 years of total experience, +2 days for mothers with children under 3, single parents, and persons with disabilities
- Article 35 six-month rule: first-time employees (or after a break of more than 5 working days) accrue 1/12 of the entitlement per month worked and can use annual leave only after 6 months of uninterrupted work — the app shows the eligibility date and warns on non-compliant bookings
- Carryover with the 30 June deadline: unused annual leave carries into the next year and expires on 30 June (leave taken before July draws from carried hours first)
- Fixed-date Kosovo public holidays are excluded from automatic day counts (movable holidays — Eids, Easter Mondays — are adjusted manually)
- Sick pay default: 20 working days per year at full salary, reset annually

> ⚠️ This is a working tool, not legal advice. Confirm edge cases with the Labour Inspectorate or your legal advisor.

## Getting started

```bash
npm install
npm run dev
```

Then open the URL Vite prints (usually http://localhost:5173).

## Build for production

```bash
npm run build
```

The static site lands in `dist/` — deployable to GitHub Pages, Netlify, or any static host.

## Data storage

All data (employees, policies, bookings) is saved in the browser's `localStorage` on the machine where you use the app. Clearing browser data clears the tracker — export/backup features are a welcome contribution.
