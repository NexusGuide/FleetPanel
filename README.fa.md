<div align="center">

# FleetPanel

### کنترل‌پنل امن برای میزبانی چندین ربات تلگرام روی یک سرور لینوکس

[![CI](https://github.com/NexusGuide/FleetPanel/actions/workflows/ci.yml/badge.svg)](https://github.com/NexusGuide/FleetPanel/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg?style=flat-square)](LICENSE)
[![Platform: Ubuntu | Debian](https://img.shields.io/badge/Platform-Ubuntu%20%7C%20Debian-orange?style=flat-square&logo=ubuntu)](docs/installation.md)
[![Security: Argon2id + AES-256-GCM](https://img.shields.io/badge/Security-Argon2id%20%2B%20AES--256--GCM-red?style=flat-square)](SECURITY.md)
[![Node.js 20.19+](https://img.shields.io/badge/Node.js-20.19%2B-green?style=flat-square&logo=node.js)](https://nodejs.org)
[![PHP 8.2+](https://img.shields.io/badge/PHP-8.2%2B-777bb4?style=flat-square&logo=php)](https://www.php.net)
[![Telegram group](https://img.shields.io/badge/Telegram-group-26A5E4?style=flat-square&logo=telegram)](https://t.me/FleetPanelGroup)

[English](README.md) · **فارسی**

</div>

<div dir="rtl">

ربات‌های **MirzaBot**، **Faoxima** و **PasarguardBot** را روی یک VPS اوبونتو یا دبیان، جدا از هم نصب و اجرا کنید.
هر ربات کاربر لینوکس، دیتابیس MySQL، سایت nginx و گواهی Let's Encrypt مخصوص خودش را دارد (به‌علاوه‌ی
PHP-FPM برای ربات‌های PHP، یا یک سرویس ایزوله‌ی systemd با Redis جدا برای ربات‌های پایتونی). مدیریت هم از
پنل وب و هم از خط فرمان (CLI) انجام می‌شود.

> **وضعیت: نسخه‌ی 0.4 (پیش‌انتشار).** پنل وب، نصب ربات‌ها، CLI و آپدیت روی یک سرور واقعی Ubuntu 24.04 با
> MirzaBot و Faoxima تست شده‌اند. پشتیبانی از PasarguardBot در v0.4.0 اضافه شده است.
> [تغییرات](CHANGELOG.md) و برنامه‌ی آینده (پایین همین صفحه) را ببینید.

---

## ⚡ نصب با یک دستور

روی یک سرور Ubuntu 24.04+ یا Debian 12+ (تازه یا در حال استفاده)، با دسترسی root:

</div>

```bash
curl -fsSL https://raw.githubusercontent.com/NexusGuide/FleetPanel/main/install.sh | sudo bash
```

<div dir="rtl">

نصب‌کننده ایمیل Let's Encrypt (اختیاری)، نام اولین مدیر و دامنه‌ی پنل (اختیاری) را می‌پرسد و در پایان آدرس پنل و
یک رمز یک‌بارمصرف را نشان می‌دهد. جزئیات و نصب بدون سؤال: [راهنمای نصب](docs/installation.md).

### نصب‌کننده چه کار می‌کند (و چه کار نمی‌کند)

- **قابل اجرای دوباره:** اجرای دوباره، پکیج‌ها و تنظیمات را به‌روز می‌کند و داده‌ای از بین نمی‌رود.
- **به سرویس‌های موجود دست نمی‌زند:** سایت‌های nginx، دیتابیس‌ها و گواهی‌های موجود را ویرایش یا حذف نمی‌کند؛
  FleetPanel فقط فایل‌های `fleetpanel-*` و دیتابیس‌های `fp_*` خودش را اضافه می‌کند. سرور MySQL/MariaDB موجود
  دوباره استفاده می‌شود.
- **بدون رمز پیش‌فرض:** اولین مدیر (Owner) یک رمز تصادفی می‌گیرد که فقط یک بار نمایش داده می‌شود و ذخیره نمی‌شود.
- **جداسازی دسترسی‌ها:** پنل با کاربر بدون دسترسی `fleetpanel` اجرا می‌شود و فقط یک ابزار کمکی root با فهرست
  مجاز دستورها، کارهایی را که root لازم دارند انجام می‌دهد.
- **TLS:** با دامنه‌ی پنل، گواهی SSL گرفته می‌شود؛ بدون دامنه، پنل روی پورت `8080` و بدون رمزنگاری بالا می‌آید
  (فقط برای تست).

---

## 🖥️ پنل وب

همه‌ی عددها و وضعیت‌ها در پنل از خود سرور می‌آیند؛ هیچ چیز ساختگی نیست.

- **داشبورد:** تعداد ربات‌ها، بار CPU، رم و دیسک سرور، فعالیت‌های اخیر
- **ربات‌ها (Instances):** ویزارد ساخت ربات، روشن/خاموش، بکاپ، **تعمیر (Repair)**، حذف (با بکاپ قبل از حذف).
  اگر نصب خطا بدهد، پنل مرحله‌ی خطادار و متن واقعی خطا را نشان می‌دهد.
- **بکاپ‌ها:** فهرست، بازگردانی (اول یک بکاپ ایمنی گرفته می‌شود)، حذف؛ **وارد کردن بکاپ دیتابیس خود ربات**
- **تنظیمات:** بکاپ رمزنگاری‌شده‌ی پنل به تلگرام با زمان‌بندی ([بازیابی بعد از خرابی سرور](docs/backup.md))
- **مدیران** (فقط Owner)، **گزارش فعالیت‌ها (Audit log)** و **حساب من** (رمز عبور، نشست‌ها)

ساخت ربات: DNS دامنه‌ی ربات را به سرور وصل کنید، بعد *New instance* ← انتخاب MirzaBot، Faoxima یا
PasarguardBot ← دامنه، توکن ربات از @BotFather و آیدی عددی تلگرام شما (PasarguardBot علاوه بر این API ID و
API Hash از [my.telegram.org](https://my.telegram.org) لازم دارد). FleetPanel نسخه‌ی قفل‌شده‌ی ربات را دانلود
می‌کند، تنظیماتش را می‌نویسد، وابستگی‌ها و جدول‌های دیتابیس را با کاربر خود ربات نصب می‌کند، دیتابیس و سایت
nginx را می‌سازد، گواهی SSL می‌گیرد و ربات را به تلگرام وصل می‌کند.

| ربات | نحوه‌ی اجرا | توضیح |
| :--- | :--- | :--- |
| MirzaBot | PHP-FPM + وب‌هوک تلگرام | پنل‌ها: Marzban، X-UI، S-UI، Hiddify و ... |
| Faoxima | PHP-FPM + وب‌هوک تلگرام | پنل‌ها: Marzban، X-UI |
| PasarguardBot | سرویس پایتون (systemd) + Redis جدا | پنل: PasarGuard · حدود ۳۰۰ مگابایت رم برای هر ربات |

---

## 🛡️ امنیت

- هش رمزها با **Argon2id** (RFC 9106: ۶۴ مگابایت، t=3، p=4)؛ نام کاربری ناموجود همان‌قدر طول می‌کشد که رمز اشتباه
- رمزنگاری **AES-256-GCM** برای توکن ربات‌ها، رمز دیتابیس‌ها و کلیدهای وب‌هوک، با داده‌ی وابسته به هر رکورد؛
  اگر کلید اصلی (master key) برای دیگران قابل خواندن باشد، سرور اجرا نمی‌شود
- **نشست‌ها** به‌صورت هش در SQLite، با `HttpOnly`، `SameSite=Strict` و `Secure` روی TLS؛ ۲ ساعت بی‌فعالیتی / ۲۴ ساعت حداکثر
- **توکن CSRF** برای هر تغییر به‌علاوه‌ی بررسی `Origin`؛ **محدودیت تعداد درخواست** برای ورود و کارهای حساس
- **RBAC** با پنج نقش روی همه‌ی مسیرهای API؛ **گزارش فعالیت غیرقابل‌تغییر** (شامل خطاها و IP کاربر)
- **بدون شل:** هر دستور با آرایه‌ی آرگومان اجرا می‌شود؛ همه‌ی ورودی‌ها با فهرست مجاز بررسی می‌شوند، و یک بار دیگر در ابزار root
- **محافظت وب‌هوک:** nginx درخواست‌های وب‌هوک بدون کلید مخفی همان ربات را رد می‌کند
- **CSP سخت‌گیرانه** برای پنل: `script-src 'self'`، بدون کد درون‌خطی و بدون منابع خارجی

جزئیات کامل: [SECURITY.md](SECURITY.md) و [docs/security.md](docs/security.md).

---

## 💻 خط فرمان FleetPanel و عیب‌یابی

`fleetpanel` در `/usr/local/bin/fleetpanel` نصب می‌شود. بدون آرگومان اجرا کنید تا منوی تعاملی باز شود
(*Logs* لاگ پنل یا هر ربات پایتونی را نشان می‌دهد؛ *Backups* فهرست بکاپ‌ها، بکاپ پنل و بازگردانی؛ *Update* آپدیت
همین الان یا تغییر کانال بین `main`، `dev` و یک نسخه‌ی مشخص):

</div>

```text
╭──────────────────────────────────────────╮
│ FleetPanel v0.4.2  ·  channel main       │
╰──────────────────────────────────────────╯
  Panel: ● running

  1) Status        5) Update
  2) Doctor        6) Firewall
  3) Logs          7) Restart panel
  4) Backups       8) Uninstall
  0) Exit
```

<div dir="rtl">

| دستور | کاربرد |
| :--- | :--- |
| `fleetpanel status` | وضعیت سرویس پنل، سلامت، نسخه و ربات‌ها |
| `fleetpanel doctor` | بررسی کامل سرور با نتیجه‌ی `[PASS]` / `[WARN]` / `[FAIL]` |
| `fleetpanel start` / `stop` / `restart` | کنترل سرویس پنل (ربات‌ها روشن می‌مانند) |
| `fleetpanel logs [N] [-f]` | N خط آخر لاگ پنل (اطلاعات محرمانه مخفی می‌شوند)؛ `-f` دنبال می‌کند |
| `fleetpanel logs SLUG [N] [-f]` | لاگ یک ربات (ربات پایتونی: خود ربات؛ ربات PHP: کرون‌جاب‌هایش) |
| `fleetpanel instances` | فهرست ربات‌ها با نوع، دامنه، ربات تلگرام و وضعیت |
| `fleetpanel backups [SLUG]` | فهرست بکاپ ربات‌ها و بکاپ‌های پنل |
| `fleetpanel backup` | بکاپ پنل: دیتابیس پنل **و کلید اصلی** |
| `fleetpanel backup SLUG` | بکاپ یک ربات (فایل‌ها + دیتابیس) |
| `fleetpanel restore FILE.fleet` | بازگردانی بکاپ رمزنگاری‌شده‌ی پنل (مثلاً از تلگرام؛ عبارت بازیابی را می‌پرسد) |
| `fleetpanel restore FILE.tar.gz` | بازگردانی بکاپ پنل (اول بکاپ ایمنی) |
| `fleetpanel restore BACKUP_ID` | بازگردانی بکاپ یک ربات (اول بکاپ ایمنی) |
| `fleetpanel admins` / `create-admin` / `reset-password` | مدیریت مدیران از روی سرور |
| `fleetpanel version` / `channel [REF]` | نمایش نسخه؛ دنبال کردن `main` یا قفل روی یک نسخه مثل `v0.3.0` |
| `fleetpanel update` | ساخت آخرین نسخه‌ی کانال و جابه‌جایی، با برگشت خودکار در صورت خطا |
| `fleetpanel firewall [enable\|disable]` | فایروال اختیاری ufw: SSH، HTTP، HTTPS و پورت پنل باز می‌مانند؛ `--block-ping` پینگ را می‌بندد |
| `fleetpanel uninstall` | حذف FleetPanel؛ ربات‌ها روشن می‌مانند مگر حذف کامل را انتخاب کنید |

مرجع کامل: [docs/cli.md](docs/cli.md).

### 🩺 بررسی سلامت سرور (doctor)

</div>

```text
FleetPanel doctor — v0.4.0, channel main

  [PASS] Panel service is running
  [PASS] API answers on 127.0.0.1:3000 ({"status":"ok","version":"0.4.0"})
  [PASS] nginx configuration is valid
  [PASS] php-fpm 8.3 configuration is valid
  [PASS] MySQL/MariaDB is reachable
  [PASS] Master key is private (600, fleetpanel, 32 bytes)
  [WARN] No control-plane backup yet: run 'sudo fleetpanel backup' and keep the file off this server
  [PASS] Privileged helper and sudoers rule are installed
  [PASS] 41 GB free on /opt/fleetpanel
  [PASS] 3911 MB RAM
  [PASS] Node.js v20.19.5
  [PASS] PHP 8.3.6 with required extensions
  [PASS] Composer is installed
  [PASS] Certificate auto-renewal is scheduled
  [PASS] Firewall (ufw) is active and allows ports 80 and 443
  [PASS] 2 instance(s), none in the error state

Summary: 15 passed, 1 warnings, 0 failed
```

<div dir="rtl">

*(خروجی نمونه است؛ مقدارهای سرور شما فرق می‌کند.)*

> **از کلید اصلی بکاپ بگیرید.** بدون `/opt/fleetpanel/config/master.key` توکن ربات‌ها و رمز دیتابیس‌ها
> باز نمی‌شوند. `sudo fleetpanel backup` را اجرا کنید و فایل را بیرون از سرور نگه دارید، یا بکاپ تلگرام را در
> تنظیمات پنل فعال کنید.

---

## 🔄 آپدیت و برگشت به نسخه‌ی قبل

`sudo fleetpanel update`:

1. کانال آپدیت (`main`، `dev` یا یک نسخه‌ی مشخص) را در یک پوشه‌ی موقت دانلود می‌کند
2. وابستگی‌ها را نصب و نسخه را می‌سازد، **در حالی که پنل روشن است**
3. پنل را متوقف و از دیتابیس پنل یک کپی می‌گیرد
4. نسخه‌ی جدید را جایگزین و ابزار root و CLI را به‌روز می‌کند
5. پنل را روشن و سلامتش را بررسی می‌کند
6. اگر بررسی سلامت شکست بخورد، **نسخه‌ی قبلی را برمی‌گرداند** و دیتابیس را از کپی بازمی‌گرداند

آپدیت پنل هیچ‌وقت ربات‌ها را متوقف نمی‌کند.

## 🧪 کانال‌های انتشار

| کانال | چه چیزی می‌گیرید | دستور |
| :--- | :--- | :--- |
| `main` | نسخه‌های پایدار (پیش‌فرض) | `sudo fleetpanel channel main && sudo fleetpanel update` |
| `dev` | نسخه‌های آزمایشی: قابلیت‌های جدید زودتر، ممکن است باگ داشته باشد | `sudo fleetpanel channel dev && sudo fleetpanel update` |
| `vX.Y.Z` | یک نسخه‌ی ثابت که تغییر نمی‌کند | `sudo fleetpanel channel v0.3.3 && sudo fleetpanel update` |

قابلیت‌های جدید اول در `dev` می‌آیند و بعد از اینکه تست‌کننده‌ها باگ‌هایشان را پیدا و رفع کردند، به `main`
می‌روند. باگ دیدید؟ یک [issue](https://github.com/NexusGuide/FleetPanel/issues) باز کنید یا در
[گروه تلگرام](https://t.me/FleetPanelGroup) بفرستید، همراه با متن خطای پنل و خروجی `sudo fleetpanel doctor`.
نصب مستقیم نسخه‌ی آزمایشی:

</div>

```bash
curl -fsSL https://raw.githubusercontent.com/NexusGuide/FleetPanel/dev/install.sh | sudo FLEETPANEL_REF=dev bash
```

<div dir="rtl">

## 🗑️ حذف

`sudo fleetpanel uninstall` دو حالت دارد:

1. **عادی** (پیش‌فرض): یک بکاپ آخر از پنل می‌گیرد، بعد پنل، سرویس، CLI و ابزار root را حذف می‌کند. ربات‌ها روشن
   می‌مانند و فایل‌ها، دیتابیس‌ها و همه‌ی بکاپ‌ها در `/opt/fleetpanel` باقی می‌مانند.
2. **حذف کامل**: باید عبارت `PERMANENTLY DELETE INSTANCES` را تایپ کنید؛ وب‌هوک‌ها را هم حذف می‌کند و فایل‌ها،
   دیتابیس و کاربر لینوکس همه‌ی ربات‌ها و همه‌ی بکاپ‌ها را پاک می‌کند.

---

## 🧪 توسعه و تست

</div>

```bash
npm ci
npm test            # API, security and provisioning tests
npm run lint        # type-checks the server and the web UI
npm run build       # dist/server.js + dist/public (the web UI)
bash -n install.sh bin/fleetpanel deploy/fleetpanel-helper
```

<div dir="rtl">

تست‌ها احراز هویت، CSRF و بررسی Origin، دسترسی‌ها (RBAC)، تلاش‌های تزریق، رمزنگاری، مراحل نصب همه‌ی ربات‌ها
(با شبیه‌سازی دستورهای سیستمی)، گزارش فعالیت و بکاپ‌ها را پوشش می‌دهند. CI بررسی نوع‌ها، تست‌ها، build و
`shellcheck` را اجرا می‌کند. [راهنمای مشارکت](CONTRIBUTING.md) را ببینید.

## 🗺️ برنامه‌ی آینده

- بازگردانی بکاپ در رباتی که حذف شده
- قفل نسخه و ارتقای جداگانه برای هر ربات
- کپی بیرون از سرور از داده‌ی خود ربات‌ها

## 📖 مستندات (انگلیسی)

- [معماری سیستم](docs/architecture.md)
- [راهنمای نصب](docs/installation.md)
- [سیاست امنیتی](SECURITY.md) و [جزئیات پیاده‌سازی](docs/security.md)
- [مرجع CLI](docs/cli.md)
- [REST API](docs/api.md)
- [ربات‌ها و نحوه‌ی نصبشان](docs/providers.md)
- [بکاپ و بازیابی بعد از خرابی سرور](docs/backup.md)
- [مشارکت](CONTRIBUTING.md) · [تغییرات](CHANGELOG.md)

## 💬 گروه کاربران

سؤال، پیشنهاد و گزارش تست: [گروه تلگرام FleetPanel](https://t.me/FleetPanelGroup).

## 📄 مجوز

FleetPanel یک نرم‌افزار متن‌باز با [مجوز MIT](LICENSE) است. MirzaBot، Faoxima و PasarguardBot پروژه‌های
جداگانه با مجوزهای خودشان هستند (PasarguardBot: AGPL-3.0)؛ FleetPanel آن‌ها را بدون تغییر و موقع نصب از
مخزن خودشان دانلود می‌کند.

</div>
