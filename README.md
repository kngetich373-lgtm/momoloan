# MoMo Loans — independent demonstration application

A mobile-first, six-stage loan application demo using a yellow, white and navy visual system. This is an independent demonstration project, **not an MTN/MTN MoMo product, partner portal, or official loan channel**. Do not present it as affiliated with MTN without written authorization.

## Application sequence

1. **Country and phone number** — country selector contains the 14 markets currently listed on the official MoMo Africa site: Benin, Cameroon, Côte d’Ivoire, Congo (Republic of the), Eswatini, Ghana, Liberia, Nigeria, Rwanda, South Africa, South Sudan, Sudan, Uganda and Zambia. Dialling codes are shown in the selector.
2. **Four-digit application PIN** — this is a local, browser-session demonstration step only. It is not an MTN MoMo wallet PIN, is not sent to the server, and must never be used to request a customer's real wallet PIN.
3. **Six-digit SMS phone verification** — verifies control of the phone number for this application only. It is not a MoMo transaction OTP. Configure a legitimate SMS provider before production.
4. **Loan application** — select $3,500–$25,000 in $500 increments, select 3/6/9/12/18/24 months, then submit profile and affordability information. After submission, the application is shown as under review.

## Run locally

Requirements: Node.js 20+ and npm.

```bash
npm ci
cp .env.example .env
npm run dev
```

Open `http://localhost:3000`.

In development, OTP delivery is intentionally printed to the server terminal. Configure an SMS provider in `src/sms.js` before production. Do not log or return production OTPs.

## Security and compliance notes

- Never ask for or collect an MTN MoMo wallet PIN, transaction OTP, banking password, or recovery code.
- The four-digit application PIN step is only a UI demonstration and is not an authentication credential.
- Phone OTP is for this independent application's phone verification only. Use a legitimate SMS provider, rate limits, short expiry, and monitoring.
- Use official MoMo APIs only with authorization, approved credentials, and the relevant country-specific configuration. Do not impersonate MTN or suggest that this demo is an official MTN loan service.
- A loan amount shown in the interface is a requested amount, not a promise, pre-approval, or guarantee of disbursement. Confirm lender licensing, disclosures, affordability checks, fees, APR, repayment schedules and local legal requirements before any real lending operation.
- Set a unique `SESSION_SECRET` of at least 32 characters, configure HTTPS, secure hosting, backups, data retention and privacy notices before deployment.

## Country research

Country list reference: https://www.momo.africa/en — official MTN MoMo site states that MoMo is available in 14 African markets and lists the countries above. Market coverage and product availability can change; confirm with MTN's official country team and MoMo developer portal before enabling a real integration.
