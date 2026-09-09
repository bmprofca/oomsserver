# Document delete OTP — Server context

> **Purpose:** Tag when changing OTP-gated document delete (client profile or task profile). Pair with client document tabs UI.

---

## Flow

```
Delete click → confirmation modal (review + Send OTP button)
  → user clicks Send OTP
  → POST …/delete/send-otp  (SMS to branch admin via company SMS / sendSmsOtp)
  → OTP input appears
  → user enters OTP → DELETE …/delete { document_ids, otp }
```

OTP type: `document_delete` (`DOCUMENT_DELETE_OTP_TYPE` in `helpers/authProfile.js`).  
Helper: `helpers/documentDeleteOtp.js`.

| Scope | Send OTP | Delete |
|-------|----------|--------|
| Client docs | `POST /client/details/documents/delete/send-otp` | `DELETE /client/details/documents/delete` |
| Task docs | `POST /task/details/document/delete/send-otp` | `DELETE /task/details/document/delete` |

Recipient is the **branch admin** (`branch_mapping.type = 'admin'`), not the acting staff. Remark binds the OTP to the sorted document-id set (hash), so it cannot be reused for a different selection.

---

## Do not

- Delete documents without verifying OTP  
- Send this OTP on the branch Fast2SMS channel — use `sendSmsOtp` (company/login SMS)  
