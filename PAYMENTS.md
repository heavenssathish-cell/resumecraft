# ResumeCraft payments

This site uses Stripe Checkout for subscriptions. Stripe hosts the actual payment page, so card details never pass through ResumeCraft.

## Activate test payments

1. In the Stripe Dashboard, switch to **Test mode** and create one product called **ResumeCraft Pro**.
2. Create two recurring USD prices for that product: **$9/month** and **$59/year**. Copy their `price_...` IDs.
3. Copy `.env.example` to `.env`, then paste your test secret key and both price IDs. Keep `.env` private.
4. Start the site with `node server.mjs` and visit `http://localhost:4242`.
5. Configure a Stripe webhook that points to `https://your-domain.com/api/stripe/webhook`. Subscribe to:
   - `checkout.session.completed`
   - `customer.subscription.updated`
   - `customer.subscription.deleted`
6. Put the webhook signing secret in `STRIPE_WEBHOOK_SECRET`.

Use Stripe's test card `4242 4242 4242 4242` with any future date and CVC while the account is in Test mode. Before launch, replace all test keys and prices with their live-mode equivalents.

## Important: Pro access

Checkout is now wired. To actually unlock Pro features for the correct person after payment, ResumeCraft also needs real sign-in and a database. In the webhook handler in `server.mjs`, save the Stripe customer/subscription ID against the authenticated user ID (`client_reference_id`) and mark that user as Pro only when Stripe reports an active or trialing subscription.

Do not unlock Pro solely because the browser returns to `?checkout=success`: the signed Stripe webhook is the reliable source of truth. The Stripe Customer Portal should similarly use the authenticated user's saved Stripe customer ID.

## Launch checklist

- Add your legal business name, support email, logo, refund policy, privacy policy, and terms in Stripe.
- Configure Customer Portal and cancellation behaviour in Stripe Billing.
- Add real authentication and a database before accepting live payments.
- Test the complete subscribe, cancel, failed-payment, and webhook flows in Test mode.
- Use HTTPS and live-mode keys only on your deployed server.
