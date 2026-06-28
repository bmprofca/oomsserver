# Backup & Export Integration Guide

This document describes the API endpoints, authentication details, request/response formats, and frontend integration examples for the Backup and Export module of the OOMS-API (`backup.js`).

---

## 🔑 Authentication & Headers

All requests to the backup endpoints must be authenticated and validated for branch-level access. The system uses custom headers rather than standard Bearer token authorization.

### Required Request Headers
| Header Name | Type | Description |
| :--- | :--- | :--- |
| `token` | String | User session authentication token |
| `username` | String | The username of the logged-in user |
| `branch` | String | The ID of the active branch |

> [!NOTE]
> For the branch context, the backend also supports passing `branch_id` as a query parameter (e.g., `?branch_id=123`) as a fallback, but using the `branch` header is highly recommended for security and consistency.

---

## 📡 API Endpoints

### 1. Get Backup Summary
Retrieve the count of records for each backing table within the user's branch. Use this to display stats (e.g., in a table or list) to the user before they trigger a backup.

* **Endpoint**: `GET /api/v1/backup/summary`
* **Authentication**: Required (headers)
* **Response Format**: `application/json`

#### Success Response (`200 OK`)
```json
{
  "success": true,
  "message": "Backup summary retrieved successfully",
  "data": {
    "tasks": {
      "title": "Tasks",
      "count": 45,
      "description": "Branch tasks, descriptions, and statuses"
    },
    "clients": {
      "title": "Clients & Firms",
      "count": 120,
      "description": "Branch clients, profiles, and associated firms"
    },
    "finance": {
      "title": "Finance Transactions",
      "count": 312,
      "description": "Financial ledger transactions"
    },
    "recurring_tasks": {
      "title": "Recurring Tasks & Schedules",
      "count": 89,
      "description": "Compliance assignments and recurring calendar schedules"
    },
    "billing": {
      "title": "Billing Invoices",
      "count": 14,
      "description": "Generated billing invoices"
    },
    "staff_management": {
      "title": "Staff & Attendance",
      "count": 55,
      "description": "Active staff mapping list and daily attendance logs"
    }
  }
}
```

---

### 2. Execute Backup
Triggers the generation of the backup export file. Supports multiple file formats and delivery methods.

* **Endpoint**: `POST /api/v1/backup/run`
* **Authentication**: Required (headers)
* **Content-Type**: `application/json`

#### Request Body Schema
| Field Name | Type | Required | Description |
| :--- | :--- | :--- | :--- |
| `sections` | String \| Array | Yes | Sections to include in the backup. Can be `"all"`, `["all"]`, or an array containing any combination of: `["tasks", "clients", "finance", "recurring_tasks", "billing", "staff_management"]` |
| `export_type` | String | Yes | Format of the export file. Must be one of: `'excel'`, `'csv'`, `'pdf'`, `'json'` |
| `delivery_method` | String | Yes | How the export should be delivered. Must be one of: `'download'`, `'email'` |
| `recipient_email` | String | Conditional | **Required if `delivery_method` is `'email'`.** Must be a valid email format. The system will email the attachment using the branch's active default SMTP configuration. |

#### Responses

##### A. Successful Local Download (`200 OK` with `delivery_method: "download"`)
Returns a relative download path for the generated file.
```json
{
  "success": true,
  "message": "Backup completed successfully.",
  "data": {
    "download_url": "/api/v1/backup/download/backup_1_2026-06-25T15-58-21.json",
    "file_name": "backup_1_2026-06-25T15-58-21.json"
  }
}
```

##### B. Successful Email Delivery (`200 OK` with `delivery_method: "email"`)
```json
{
  "success": true,
  "message": "Backup completed and exported via email successfully."
}
```

##### C. Validation / Setup Error (`400 Bad Request`)
Returned if parameters are missing or invalid (e.g. invalid delivery method, email, or missing branch SMTP configuration).
```json
{
  "success": false,
  "message": "No active default SMTP configuration found for this branch. Please set it up or choose the local download option."
}
```

---

### 3. Download Backup File
Securely stream and download a generated backup file.

* **Endpoint**: `GET /api/v1/backup/download/:fileName`
* **Authentication**: Required (headers)
* **Response Format**: Binary stream / File download (`Content-Disposition: attachment`)

> [!IMPORTANT]
> **Access Control Rules:**
> - The file name requested in the URL path (`:fileName`) must start with the prefix `backup_<branch_id>_` corresponding to the user's `branch` header.
> - If a user attempts to download a backup file belonging to another branch, they will receive a `403 Forbidden` error.
> - If the file has been cleaned up or does not exist, a `404 Not Found` error will be returned.

---

## 💻 Frontend Implementation Example (JavaScript / Axios)

Because the `/download` route requires authentication headers (`token`, `username`, `branch`), a standard `<a href="...">` link will fail with a `401 Unauthorized` or `400 Bad Request` error. 

Below is the recommended pattern to download the file as a Blob using custom headers on the frontend:

### 1. Download Helper Function

```javascript
/**
 * Triggers the browser download dialog for a protected backup file by fetching it as a Blob.
 * 
 * @param {string} downloadUrl - The /api/v1/backup/download/:fileName relative path
 * @param {string} fileName - The target filename to save as
 * @param {object} credentials - The current user's session credentials
 */
async function triggerBackupDownload(downloadUrl, fileName, credentials) {
  try {
    const response = await fetch(downloadUrl, {
      method: 'GET',
      headers: {
        'token': credentials.token,
        'username': credentials.username,
        'branch': credentials.branchId
      }
    });

    if (!response.ok) {
      const errData = await response.json().catch(() => ({ message: 'Failed to download file' }));
      throw new Error(errData.message || `HTTP error! status: ${response.status}`);
    }

    // Convert response stream to blob
    const blob = await response.blob();
    
    // Create local object URL for the blob
    const url = window.URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.setAttribute('download', fileName);
    
    document.body.appendChild(link);
    link.click();
    
    // Clean up
    link.parentNode.removeChild(link);
    window.URL.revokeObjectURL(url);
  } catch (error) {
    console.error('Error downloading backup:', error);
    alert(`Download failed: ${error.message}`);
  }
}
```

### 2. Complete Integration Flow (React / Vanilla JS)

```javascript
// Active user credentials in frontend state
const credentials = {
  token: "USER_SESSION_TOKEN_HERE",
  username: "johndoe",
  branchId: "1"
};

// Fetch and render stats on the backup dashboard
async function loadBackupDashboard() {
  try {
    const res = await fetch('/api/v1/backup/summary', {
      headers: {
        'token': credentials.token,
        'username': credentials.username,
        'branch': credentials.branchId
      }
    });
    
    const result = await res.json();
    if (result.success) {
      // Bind data to UI (e.g. result.data.tasks.count)
      console.log('Summary stats:', result.data);
    } else {
      console.error('Failed to load backup stats:', result.message);
    }
  } catch (error) {
    console.error('Error:', error);
  }
}

// Request and handle backup creation
async function handleBackupSubmit(options) {
  try {
    const response = await fetch('/api/v1/backup/run', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'token': credentials.token,
        'username': credentials.username,
        'branch': credentials.branchId
      },
      body: JSON.stringify({
        sections: options.sections,         // e.g. "all" or ["tasks", "finance"]
        export_type: options.exportType,   // "excel" | "csv" | "pdf"
        delivery_method: options.method,    // "download" | "email"
        recipient_email: options.email      // (optional, required if method is "email")
      })
    });

    const result = await response.json();

    if (!result.success) {
      alert(`Backup error: ${result.message}`);
      return;
    }

    if (options.method === 'email') {
      alert('Backup compiled and sent to your email successfully!');
    } else if (options.method === 'download' && result.data?.download_url) {
      // Trigger the secure blob download
      await triggerBackupDownload(result.data.download_url, result.data.file_name, credentials);
    }
  } catch (error) {
    console.error('Backup request failed:', error);
    alert('An unexpected network error occurred.');
  }
}
```

---

### 4. Import Backup Data
Import and restore a JSON backup file or raw JSON payload back into the database.

* **Endpoint**: `POST /api/v1/backup/import`
* **Authentication**: Required (headers)
* **Content-Type**: `multipart/form-data` (uploading the JSON backup under file field key `file`) OR `application/json` (sending the JSON backup payload directly in the request body)

#### Response Format: `application/json`

##### Success Response (`200 OK`)
```json
{
  "success": true,
  "message": "Backup data imported and restored successfully"
}
```

##### Error Response (`400 Bad Request` / `500 Internal Server Error`)
```json
{
  "success": false,
  "message": "Invalid JSON format in backup file"
}
```

