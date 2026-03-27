# دليل تكامل الفرونت — تسجيل المستخدمين والدخول (Email + Password)

هذا الملف يوثّق تغييرات الـ API المتعلقة بإنشاء المستخدمين وتسجيل الدخول بالبريد وكلمة المرور، حتى يحدّث الفرونت النماذج والطلبات (`fetch` / Axios) بشكل صحيح.

---

## ملخص سريع: ما الذي تغيّر؟

| المسار | التغيير |
|--------|---------|
| `POST /auth/login` | **لم يتغيّر** — ما زال يتوقع `email` و `password`. |
| `POST /users` | **تغيير مهم:** أصبح **إلزاميًا** إرسال `email` مع بقية الحقول؛ تمت إضافة تحققات وحقول في الاستجابة. |
| `POST /auth/register` | **تغيير مهم:** أصبح **إلزاميًا** إرسال `email`؛ الاستجابة ترجع `user` بدون `password_hash`. |
| `POST /public/signup` | **تغيير مهم:** أصبح **إلزاميًا** إرسال `email`؛ الاستجابة ترجع `user` آمنًا (بدون hash). |
| `POST /public/create-owner-user` | **تغيير مهم:** أصبح **إلزاميًا** إرسال `email`؛ الاستجابة آمنة. |

**قاعدة عامة:** البريد يُخزَّن بعد **تطبيع** (إزالة المسافات + أحرف صغيرة). استخدم نفس البريد عند تسجيل الدخول.

---

## تسجيل الدخول (بدون تغيير)

**`POST /auth/login`**

Headers: `Content-Type: application/json`

Body:

```json
{
  "email": "user@example.com",
  "password": "your-password"
}
```

نجاح `200`:

```json
{
  "access_token": "<JWT>",
  "user": { "...": "حقول المستخدم بدون password_hash" },
  "merchant_name": "...",
  "branch_name": "..."
}
```

شروط الرفض الشائعة:

- `400` — `email and password required`
- `401` — `Invalid credentials`
- `403` — `Account not active` أو `Email not verified` (مسار التسجيل العام `/auth/signup` يتطلب تأكيد البريد قبل الدخول)

---

## إنشاء مستخدم من لوحة الإدارة (موظفين)

**`POST /users`**

- يتطلب **مصادقة**: `Authorization: Bearer <access_token>`
- المستخدم الحالي يجب أن يكون ضمن تاجر (`merchant`) ولديه صلاحية إدارة المستخدمين.

Body (الحقول **الإلزامية** الجديدة مقارنة بالقديم):

```json
{
  "name": "اسم العرض",
  "email": "staff@example.com",
  "password": "min6chars",
  "role": "manager",
  "branch_id": 1,
  "status": "active"
}
```

| الحقل | مطلوب؟ | ملاحظات |
|-------|--------|---------|
| `name` | نعم | |
| `email` | **نعم (جديد)** | فريد على مستوى النظام؛ تكرار يرجع `409`. |
| `password` | نعم | **6 أحرف على الأقل** |
| `role` | نعم | واحدة من: `owner`, `manager`, `cashier`, `kitchen` |
| `branch_id` | لا | رقم أو `null` — يجب أن يكون الفرع للتاجر الحالي |
| `status` | لا | الافتراضي `active`؛ القيم المسموحة: `active`, `disabled` |

استجابة `201`: كائن مستخدم (بدون `password_hash`)، ويشمل عادةً `email`, `email_verified_at`, `role`, `status`, إلخ.

أخطاء شائعة:

- `400` — `name, email, password, and role required` أو `Invalid email` أو `password must be at least 6 characters`
- `409` — `Email already registered`
- `400` — `User name already exists` (نفس الاسم داخل نفس التاجر)

---

## تسجيل تاجر + مالك (Legacy سريع)

**`POST /auth/register`**

Body:

```json
{
  "name": "اسم المالك",
  "email": "owner@example.com",
  "password": "...",
  "merchant_name": "اسم المحل"
}
```

| الحقل | ملاحظة |
|-------|--------|
| `email` | **إلزامي (جديد)** — فريد؛ تكرار → `409` |

استجابة `201`:

```json
{
  "merchant": { "...": "..." },
  "user": { "...": "بدون password_hash" }
}
```

---

## تسجيل عام: تاجر + مالك (Public)

**`POST /public/signup`**

Body السابق كان: `username`, `merchant_name`, `password`.

Body **الحالي**:

```json
{
  "username": "اسم_العرض_أو_المستخدم",
  "email": "owner@example.com",
  "merchant_name": "اسم المحل",
  "password": "..."
}
```

| الحقل | ملاحظة |
|-------|--------|
| `email` | **إلزامي (جديد)** — فريد؛ تكرار → `409` |

استجابة `201`: `merchant` + `user` (المستخدم بدون `password_hash`).

---

## إنشاء مالك لم تاجر موجود (Public — Legacy)

**`POST /public/create-owner-user`**

Body:

```json
{
  "name": "اسم المالك",
  "email": "owner@example.com",
  "password": "...",
  "merchant_id": 123
}
```

| الحقل | ملاحظة |
|-------|--------|
| `email` | **إلزامي (جديد)** — فريد؛ تكرار → `409` |

---

## ما الذي يجب على الفرونت تحديثه عمليًا؟

1. **نماذج إنشاء مستخدم (إدارة)**  
   إضافة حقل **البريد الإلكتروني** مع التحقق من الصيغة؛ إرسال `email` في جسم `POST /users`.

2. **نماذج التسجيل العامة أو Legacy**  
   إذا كانت تستدعي `/auth/register` أو `/public/signup` أو `/public/create-owner-user`، أضف `email` وأظهر أخطاء `409` (`Email already registered`) للمستخدم.

3. **تسجيل الدخول**  
   يبقى الحقل `email` (وليس اسم المستخدم فقط) مع `password`.

4. **التحقق من كلمة المرور في الواجهة**  
   لـ `POST /users` الحد الأدنى **6** أحرف لتطابق رسالة الخادم.

---

## ملف مساعد في الباكند

- `lib/email.js` — دالة تطبيع البريد (لا حاجة لاستدعائها من الفرونت؛ فقط أرسل البريد كما يكتبه المستخدم والخادم يطبّع).

---

## مسارات مرجعية (Base URL حسب بيئتكم)

| الوظيفة | Method | Path |
|---------|--------|------|
| Login | POST | `/auth/login` |
| Signup (تأكيد بريد) | POST | `/auth/signup` |
| Register (سريع) | POST | `/auth/register` |
| إنشاء مستخدم (إدارة) | POST | `/users` |
| Public signup | POST | `/public/signup` |
| Create owner لم تاجر | POST | `/public/create-owner-user` |

جميع الطلبات أعلاه (ما عدا التي تحتاج Bearer) تستخدم `Content-Type: application/json`.
