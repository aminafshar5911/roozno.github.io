# راه‌اندازی اعلان حرفه‌ای روزنو (اعلان در حالت بسته بودن برنامه)

این بسته کد سمت سایت و Edge Function را آماده کرده است؛ برای کارکرد واقعی اعلان در حالت بسته باید تنظیمات زیر یک بار در Supabase انجام شوند. **صرف جایگزینی فایل‌های سایت کافی نیست.**

## ۱) آپلود فایل‌های سایت
محتویات ZIP را در ریشه repository فعلی GitHub Pages جایگزین کن. این نسخه `app.js` و `index.html` و `sw.js` را تغییر داده و پوشه `supabase` را هم اضافه کرده است. فعلاً آدرس سایت و مقادیر Supabase موجود حفظ شده‌اند.

## ۲) ساخت جدول‌های اعلان
در Supabase → SQL Editor، کل فایل `supabase/push_notifications.sql` را اجرا کن. این دستورها جدول‌های جداگانه‌ی اعلان را می‌سازند و به جدول `planner_data` دست نمی‌زنند.

## ۳) تولید کلیدهای VAPID
کلید عمومی برای سایت و کلید خصوصی برای سرور است. کلید خصوصی را هرگز در `app.js`، GitHub یا چت قرار نده.
روی کامپیوتر، اگر Node.js نصب است، در ترمینال اجرا کن:

```bash
npx web-push generate-vapid-keys
```

خروجی شامل `Public Key` و `Private Key` است. آن‌ها را امن نگه دار.

## ۴) تنظیم کلید عمومی در سایت
در `app.js` این خط را پیدا کن:

```js
const VAPID_PUBLIC_KEY = "PASTE_VAPID_PUBLIC_KEY_HERE";
```

فقط مقدار کلید **Public** را جایگزین کن. فایل را ذخیره و در GitHub آپلود کن.

## ۵) ساخت Edge Function در Supabase
در پوشه‌ی `supabase/functions/send-reminders/index.ts` کد آماده است. با Supabase CLI از ریشه‌ی پروژه اجرا کن:

```bash
supabase login
supabase link --project-ref bqzrvmnzgytjpdlxbtup
supabase functions deploy send-reminders --no-verify-jwt
```

در Supabase → Edge Functions → `send-reminders` → Secrets، این متغیرها را بساز:

- `SUPABASE_URL` = آدرس پروژه فعلی
- `SUPABASE_SERVICE_ROLE_KEY` = کلید **secret/service_role** پروژه (فقط در Secrets سرور)
- `VAPID_PUBLIC_KEY` = کلید عمومی مرحله ۳
- `VAPID_PRIVATE_KEY` = کلید خصوصی مرحله ۳
- `VAPID_SUBJECT` = یک مقدار تماس، مثلاً `mailto:your-email@example.com`
- `CRON_SECRET` = یک رمز تصادفی بلند که خودت تولید می‌کنی

از کلیدهای secret/service_role فقط در تنظیمات امن سرور استفاده کن؛ هیچ‌وقت آن را داخل فایل‌های سایت نگذار.

## ۶) زمان‌بندی اجرای تابع هر دقیقه
در Supabase Dashboard → Integrations/ Cron (ممکن است در بخش Database باشد)، یک job بساز که هر دقیقه با `POST` این تابع را صدا بزند:

`https://bqzrvmnzgytjpdlxbtup.supabase.co/functions/v1/send-reminders`

Headerها:

- `Content-Type: application/json`
- `x-cron-secret: <همان CRON_SECRET مرحله ۵>`

Body: `{}`

از امکان ارسال HTTP درخواست در Supabase Cron استفاده کن و رمز را در تنظیمات امن/Secrets نگه دار؛ آن را داخل repository عمومی ننویس. اگر داشبورد Cron در پروژه‌ات این امکان را نداشت، بگو تا مسیر جایگزین را قدم‌به‌قدم تنظیم کنیم.

## ۷) فعال‌سازی در گوشی
1. سایت را در Chrome اندروید با اینترنت باز کن.
2. وارد همان حساب گوگل روزنو شو.
3. روی «🔔 فعال‌سازی اعلان» بزن و اجازه‌ی اعلان را بده.
4. بهتر است روزنو را از منوی Chrome با گزینه‌ی «نصب برنامه / Add to Home screen» نصب کنی.
5. برای آزمایش، یک برنامه برای چند دقیقه بعد تنظیم کن. گوشی باید روشن و متصل به اینترنت باشد و اعلان‌های Chrome/روزنو در تنظیمات اندروید مسدود نشده باشند.

## نکات مهم
- پس از تکمیل مراحل، Edge Function هر دقیقه برنامه‌های موعدرسیده را بررسی می‌کند؛ ممکن است اعلان با حدود یک دقیقه تأخیر برسد.
- اگر صفحه‌ی روزنو باز باشد، اعلان محلی هم فعال است؛ این مسیر به‌تنهایی برای برنامه‌ی کاملاً بسته تضمین نمی‌دهد.
- ساعت برنامه‌ها بر اساس منطقه زمانی دستگاهی است که اعلان را ثبت می‌کند. اگر چند دستگاه در منطقه‌های زمانی متفاوت داری، برای حساب یک منطقه زمانی ثابت انتخاب کن.
- اگر گوشی خاموش یا بدون اینترنت باشد، دریافت فوری تضمین نمی‌شود.
- اعلان وب روی Android/Chrome معمولاً پشتیبانی می‌شود؛ سازگاری به نسخه‌ی مرورگر و تنظیمات دستگاه بستگی دارد.
