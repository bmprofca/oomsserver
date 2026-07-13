const fs = require('fs');
const path = require('path');

const MAPPING = {
    sale: ["classic", "modern", "elegant", "corporate", "creative", "compact", "professional", "boutique"],
    purchase: ["classic", "modern", "elegant", "corporate", "creative"],
    payment: ["classic", "modern", "elegant", "corporate", "creative"],
    receive: ["classic", "modern", "elegant", "corporate", "creative"],
    journal: ["classic", "modern", "minimal"],
    contra: ["classic", "modern", "minimal"],
    expense: ["classic", "modern", "minimal"],
};

const THEMES = {
    classic: `
  *{box-sizing:border-box;margin:0;padding:0;}
  body{font-family:'Segoe UI',Tahoma,Arial,sans-serif;font-size:13px;color:#333;background:#fff;width:794px;}
  .page{width:794px;min-height:1123px;padding:0;position:relative;background:#fff;}
  .header{padding:40px 48px 30px;background:#f8f9fa;border-bottom:3px solid #0056b3;display:flex;justify-content:space-between;}
  .company-name{font-size:24px;font-weight:bold;color:#0056b3;margin-bottom:8px;}
  .company-details{font-size:12px;color:#555;line-height:1.6;}
  .invoice-type-label{font-size:14px;font-weight:bold;text-transform:uppercase;color:#0056b3;letter-spacing:1px;margin-bottom:8px;}
  .invoice-num-val{font-size:16px;font-weight:bold;color:#333;}
  .invoice-num-label{font-size:11px;color:#777;text-transform:uppercase;display:block;}
  .meta-strip{background:#fff;padding:20px 48px;display:flex;gap:40px;border-bottom:1px solid #eee;}
  .meta-label{font-size:10px;font-weight:bold;color:#777;text-transform:uppercase;margin-bottom:4px;}
  .meta-value{font-size:13px;font-weight:bold;color:#333;}
  .body{padding:30px 48px;}
  .party-section{display:flex;gap:30px;margin-bottom:30px;}
  .party-card{flex:1;background:#fcfcfc;border:1px solid #e0e0e0;padding:20px;border-top:3px solid #0056b3;}
  .party-card-label{font-size:10px;font-weight:bold;color:#777;text-transform:uppercase;margin-bottom:8px;}
  .party-name{font-size:15px;font-weight:bold;color:#333;margin-bottom:6px;}
  .party-detail{font-size:12px;color:#555;line-height:1.6;}
  .table-title{font-size:12px;font-weight:bold;color:#0056b3;text-transform:uppercase;margin-bottom:12px;}
  .items-table{width:100%;border-collapse:collapse;margin-bottom:30px;}
  .items-table th{background:#f4f6f8;color:#0056b3;padding:12px;font-size:11px;text-transform:uppercase;text-align:left;border-bottom:2px solid #ccc;}
  .items-table td{padding:12px;font-size:13px;color:#444;border-bottom:1px solid #eee;vertical-align:top;}
  .items-table th:last-child, .items-table td:last-child{text-align:right;}
  .totals-section{display:flex;justify-content:flex-end;margin-bottom:30px;}
  .totals-box{width:300px;}
  .totals-row{display:flex;justify-content:space-between;padding:10px 0;border-bottom:1px solid #eee;}
  .totals-row.grand{border-top:2px solid #0056b3;border-bottom:none;margin-top:5px;padding-top:15px;}
  .t-label{color:#555;font-weight:bold;}
  .t-value{color:#333;font-weight:bold;}
  .totals-row.grand .t-label, .totals-row.grand .t-value{font-size:16px;color:#0056b3;}
  .voucher-section{background:#fcfcfc;border:1px solid #e0e0e0;padding:25px;margin-bottom:30px;border-left:4px solid #0056b3;}
  .voucher-row{display:flex;justify-content:space-between;padding:12px 0;border-bottom:1px dotted #ccc;}
  .voucher-row:last-child{border-bottom:none;}
  .voucher-label{font-size:11px;font-weight:bold;color:#777;text-transform:uppercase;}
  .voucher-value{font-size:13px;font-weight:bold;color:#333;}
  .amount-highlight{font-size:20px;font-weight:bold;color:#0056b3;}
  .remark-section{background:#fdfcf0;border:1px solid #f3e5b3;padding:20px;margin-bottom:30px;}
  .remark-label{font-size:10px;font-weight:bold;color:#9b7a14;text-transform:uppercase;margin-bottom:6px;}
  .remark-text{font-size:12px;color:#5c490a;line-height:1.6;}
  .footer{position:absolute;bottom:0;width:100%;padding:20px 48px;background:#f8f9fa;border-top:1px solid #ddd;display:flex;justify-content:space-between;font-size:11px;color:#777;}
  .footer-brand{font-weight:bold;color:#0056b3;}
    `,
    modern: `
  *{box-sizing:border-box;margin:0;padding:0;}
  body{font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;font-size:13px;color:#2d3748;background:#fff;width:794px;}
  .page{width:794px;min-height:1123px;padding:0;position:relative;}
  .header{padding:48px;display:flex;justify-content:space-between;align-items:center;}
  .company-name{font-size:22px;font-weight:600;color:#1a202c;margin-bottom:4px;letter-spacing:-0.5px;}
  .company-details{font-size:12px;color:#718096;line-height:1.5;}
  .invoice-type-label{font-size:12px;font-weight:600;text-transform:uppercase;color:#4a5568;letter-spacing:2px;margin-bottom:6px;text-align:right;}
  .invoice-num-val{font-size:18px;font-weight:300;color:#2d3748;text-align:right;}
  .invoice-num-label{display:none;}
  .meta-strip{margin:0 48px;padding:24px 0;display:flex;gap:48px;border-top:1px solid #e2e8f0;border-bottom:1px solid #e2e8f0;}
  .meta-label{font-size:9px;font-weight:600;color:#a0aec0;text-transform:uppercase;letter-spacing:1px;margin-bottom:6px;}
  .meta-value{font-size:14px;font-weight:500;color:#2d3748;}
  .body{padding:36px 48px;}
  .party-section{display:flex;gap:36px;margin-bottom:40px;}
  .party-card{flex:1;}
  .party-card-label{font-size:9px;font-weight:600;color:#a0aec0;text-transform:uppercase;letter-spacing:1px;margin-bottom:10px;}
  .party-name{font-size:16px;font-weight:500;color:#1a202c;margin-bottom:6px;}
  .party-detail{font-size:12px;color:#718096;line-height:1.6;}
  .table-title{display:none;}
  .items-table{width:100%;border-collapse:collapse;margin-bottom:40px;}
  .items-table th{padding:12px 0;font-size:10px;font-weight:600;color:#a0aec0;text-transform:uppercase;letter-spacing:1px;border-bottom:2px solid #e2e8f0;text-align:left;}
  .items-table td{padding:16px 0;font-size:13px;color:#4a5568;border-bottom:1px solid #edf2f7;vertical-align:top;}
  .items-table th:last-child, .items-table td:last-child{text-align:right;}
  .totals-section{display:flex;justify-content:flex-end;margin-bottom:40px;}
  .totals-box{width:280px;}
  .totals-row{display:flex;justify-content:space-between;padding:12px 0;font-size:14px;}
  .t-label{color:#718096;}
  .t-value{color:#2d3748;font-weight:500;}
  .totals-row.grand{border-top:2px solid #2d3748;margin-top:8px;padding-top:16px;}
  .totals-row.grand .t-label, .totals-row.grand .t-value{font-size:18px;font-weight:600;color:#1a202c;}
  .voucher-section{padding:0;margin-bottom:40px;}
  .voucher-row{display:flex;justify-content:space-between;padding:16px 0;border-bottom:1px solid #edf2f7;}
  .voucher-label{font-size:11px;font-weight:600;color:#a0aec0;text-transform:uppercase;letter-spacing:1px;}
  .voucher-value{font-size:14px;color:#4a5568;font-weight:500;}
  .amount-highlight{font-size:24px;font-weight:300;color:#1a202c;}
  .remark-section{margin-bottom:40px;}
  .remark-label{font-size:9px;font-weight:600;color:#a0aec0;text-transform:uppercase;letter-spacing:1px;margin-bottom:8px;}
  .remark-text{font-size:12px;color:#718096;line-height:1.6;}
  .footer{position:absolute;bottom:48px;left:48px;right:48px;display:flex;justify-content:space-between;font-size:10px;color:#a0aec0;border-top:1px solid #e2e8f0;padding-top:16px;}
    `,
    elegant: `
  *{box-sizing:border-box;margin:0;padding:0;}
  body{font-family:'Georgia',serif;font-size:13px;color:#3b3a36;background:#fffaf0;width:794px;}
  .page{width:794px;min-height:1123px;padding:0;position:relative;}
  .header{padding:50px 50px 30px;text-align:center;border-bottom:1px solid #d4c4a8;background:#fffaf0;}
  .company-name{font-size:28px;font-weight:normal;color:#2c2b29;letter-spacing:2px;margin-bottom:10px;text-transform:uppercase;}
  .company-details{font-family:'Helvetica Neue',sans-serif;font-size:11px;color:#6b675d;line-height:1.8;letter-spacing:0.5px;}
  .invoice-type-label{font-size:16px;font-style:italic;color:#5a5446;margin-top:25px;margin-bottom:5px;}
  .invoice-num-val{font-family:'Helvetica Neue',sans-serif;font-size:14px;color:#3b3a36;}
  .invoice-num-label{display:none;}
  .meta-strip{display:flex;justify-content:center;gap:40px;padding:15px 0;background:#fdf9f1;border-bottom:1px solid #d4c4a8;}
  .meta-label{font-family:'Helvetica Neue',sans-serif;font-size:9px;color:#8a8373;text-transform:uppercase;letter-spacing:2px;margin-bottom:4px;text-align:center;}
  .meta-value{font-size:13px;color:#3b3a36;text-align:center;}
  .body{padding:40px 50px;}
  .party-section{display:flex;justify-content:space-between;margin-bottom:40px;}
  .party-card{flex:0 0 45%;}
  .party-card-label{font-family:'Helvetica Neue',sans-serif;font-size:9px;color:#8a8373;text-transform:uppercase;letter-spacing:2px;margin-bottom:12px;border-bottom:1px solid #e8e0d0;padding-bottom:5px;}
  .party-name{font-size:16px;color:#2c2b29;margin-bottom:6px;}
  .party-detail{font-family:'Helvetica Neue',sans-serif;font-size:12px;color:#5a5446;line-height:1.7;}
  .table-title{display:none;}
  .items-table{width:100%;border-collapse:collapse;margin-bottom:40px;}
  .items-table th{font-family:'Helvetica Neue',sans-serif;padding:12px 5px;font-size:9px;color:#8a8373;text-transform:uppercase;letter-spacing:2px;border-bottom:1px solid #d4c4a8;text-align:left;}
  .items-table td{padding:16px 5px;font-size:13px;color:#3b3a36;border-bottom:1px dashed #e8e0d0;vertical-align:top;}
  .items-table th:last-child, .items-table td:last-child{text-align:right;}
  .totals-section{display:flex;justify-content:flex-end;margin-bottom:40px;}
  .totals-box{width:300px;}
  .totals-row{display:flex;justify-content:space-between;padding:10px 0;font-size:14px;}
  .t-label{font-family:'Helvetica Neue',sans-serif;color:#5a5446;font-size:12px;letter-spacing:1px;}
  .t-value{color:#3b3a36;}
  .totals-row.grand{border-top:1px solid #d4c4a8;margin-top:10px;padding-top:15px;}
  .totals-row.grand .t-label{font-size:14px;color:#2c2b29;}
  .totals-row.grand .t-value{font-size:18px;color:#2c2b29;font-weight:bold;}
  .voucher-section{padding:30px;background:#fdf9f1;border:1px solid #e8e0d0;margin-bottom:40px;}
  .voucher-row{display:flex;justify-content:space-between;padding:12px 0;border-bottom:1px dashed #e8e0d0;}
  .voucher-row:last-child{border-bottom:none;}
  .voucher-label{font-family:'Helvetica Neue',sans-serif;font-size:10px;color:#8a8373;text-transform:uppercase;letter-spacing:2px;}
  .voucher-value{font-size:14px;color:#3b3a36;}
  .amount-highlight{font-size:22px;color:#2c2b29;}
  .remark-section{margin-bottom:40px;text-align:center;font-style:italic;color:#6b675d;}
  .remark-label{display:none;}
  .remark-text{font-size:13px;line-height:1.6;}
  .footer{position:absolute;bottom:0;width:100%;text-align:center;padding:20px;font-family:'Helvetica Neue',sans-serif;font-size:10px;color:#8a8373;border-top:1px solid #e8e0d0;background:#fdf9f1;}
    `,
    corporate: `
  *{box-sizing:border-box;margin:0;padding:0;}
  body{font-family:'Roboto',Arial,sans-serif;font-size:12px;color:#343a40;background:#fff;width:794px;}
  .page{width:794px;min-height:1123px;padding:0;position:relative;}
  .header{padding:40px 48px;display:flex;justify-content:space-between;background:#f4f6f9;border-bottom:1px solid #dee2e6;}
  .company-name{font-size:20px;font-weight:bold;color:#1f2937;margin-bottom:5px;letter-spacing:0.5px;}
  .company-details{font-size:11px;color:#6c757d;line-height:1.6;}
  .invoice-type-label{font-size:18px;font-weight:bold;color:#495057;text-transform:uppercase;margin-bottom:5px;text-align:right;}
  .invoice-num-row{text-align:right;}
  .invoice-num-label{font-size:11px;color:#6c757d;text-transform:uppercase;margin-right:8px;}
  .invoice-num-val{font-size:14px;font-weight:bold;color:#212529;}
  .meta-strip{background:#e9ecef;padding:15px 48px;display:flex;gap:35px;border-bottom:1px solid #dee2e6;}
  .meta-label{font-size:10px;font-weight:bold;color:#495057;text-transform:uppercase;margin-bottom:4px;}
  .meta-value{font-size:12px;font-weight:bold;color:#212529;}
  .body{padding:30px 48px;}
  .party-section{display:flex;gap:20px;margin-bottom:30px;}
  .party-card{flex:1;background:#fff;border:1px solid #dee2e6;border-radius:4px;padding:15px;}
  .party-card-label{font-size:10px;font-weight:bold;color:#6c757d;text-transform:uppercase;margin-bottom:8px;background:#f8f9fa;padding:4px 8px;border-radius:2px;display:inline-block;}
  .party-name{font-size:14px;font-weight:bold;color:#212529;margin-bottom:4px;margin-top:5px;}
  .party-detail{font-size:11px;color:#495057;line-height:1.5;}
  .table-title{display:none;}
  .items-table{width:100%;border-collapse:collapse;margin-bottom:30px;border:1px solid #dee2e6;}
  .items-table th{background:#f8f9fa;color:#495057;padding:10px;font-size:10px;font-weight:bold;text-transform:uppercase;border-bottom:1px solid #dee2e6;border-right:1px solid #dee2e6;text-align:left;}
  .items-table td{padding:10px;font-size:12px;color:#343a40;border-bottom:1px solid #dee2e6;border-right:1px solid #dee2e6;vertical-align:top;}
  .items-table th:last-child, .items-table td:last-child{text-align:right;border-right:none;}
  .totals-section{display:flex;justify-content:flex-end;margin-bottom:30px;}
  .totals-box{width:260px;background:#f8f9fa;border:1px solid #dee2e6;border-radius:4px;padding:15px;}
  .totals-row{display:flex;justify-content:space-between;padding:6px 0;font-size:12px;}
  .t-label{color:#495057;font-weight:bold;}
  .t-value{color:#212529;}
  .totals-row.grand{border-top:1px solid #dee2e6;margin-top:6px;padding-top:10px;}
  .totals-row.grand .t-label{font-size:14px;color:#212529;}
  .totals-row.grand .t-value{font-size:16px;font-weight:bold;color:#212529;}
  .voucher-section{border:1px solid #dee2e6;border-radius:4px;margin-bottom:30px;}
  .voucher-row{display:flex;justify-content:space-between;padding:12px 20px;border-bottom:1px solid #dee2e6;background:#fff;}
  .voucher-row:nth-child(even){background:#f8f9fa;}
  .voucher-row:last-child{border-bottom:none;}
  .voucher-label{font-size:11px;font-weight:bold;color:#6c757d;text-transform:uppercase;}
  .voucher-value{font-size:13px;color:#212529;font-weight:bold;}
  .amount-highlight{font-size:18px;color:#212529;}
  .remark-section{background:#e9ecef;border-left:4px solid #6c757d;padding:15px;margin-bottom:30px;}
  .remark-label{font-size:10px;font-weight:bold;color:#495057;text-transform:uppercase;margin-bottom:4px;}
  .remark-text{font-size:11px;color:#343a40;line-height:1.5;}
  .footer{position:absolute;bottom:0;width:100%;padding:15px 48px;background:#343a40;color:#f8f9fa;display:flex;justify-content:space-between;font-size:10px;}
  .footer-brand{font-weight:bold;color:#fff;}
    `,
    creative: `
  *{box-sizing:border-box;margin:0;padding:0;}
  body{font-family:'Nunito',sans-serif;font-size:13px;color:#4a4a4a;background:#fff;width:794px;}
  .page{width:794px;min-height:1123px;padding:0;position:relative;}
  .header{padding:40px 48px;background:#f9f5ff;display:flex;justify-content:space-between;border-bottom-right-radius:40px;}
  .company-name{font-size:24px;font-weight:800;color:#6b46c1;margin-bottom:8px;}
  .company-details{font-size:12px;color:#718096;line-height:1.5;}
  .invoice-badge{text-align:right;}
  .invoice-type-label{display:inline-block;background:#e9d8fd;color:#6b46c1;font-size:12px;font-weight:bold;text-transform:uppercase;padding:6px 16px;border-radius:20px;margin-bottom:12px;letter-spacing:1px;}
  .invoice-num-val{font-size:18px;font-weight:700;color:#4a4a4a;display:block;}
  .invoice-num-label{font-size:10px;color:#a0aec0;text-transform:uppercase;letter-spacing:1px;}
  .meta-strip{padding:20px 48px;display:flex;gap:40px;margin-top:10px;}
  .meta-item{background:#f7fafc;padding:12px 20px;border-radius:12px;flex:1;}
  .meta-label{font-size:10px;font-weight:bold;color:#a0aec0;text-transform:uppercase;margin-bottom:4px;}
  .meta-value{font-size:14px;font-weight:800;color:#2d3748;}
  .body{padding:20px 48px;}
  .party-section{display:flex;gap:30px;margin-bottom:30px;}
  .party-card{flex:1;}
  .party-card-label{font-size:10px;font-weight:bold;color:#6b46c1;text-transform:uppercase;margin-bottom:8px;letter-spacing:1px;}
  .party-name{font-size:16px;font-weight:800;color:#2d3748;margin-bottom:4px;}
  .party-detail{font-size:12px;color:#718096;line-height:1.6;}
  .table-title{display:none;}
  .items-table{width:100%;border-collapse:collapse;margin-bottom:40px;}
  .items-table th{padding:12px 16px;font-size:11px;font-weight:bold;color:#6b46c1;text-transform:uppercase;background:#f9f5ff;text-align:left;}
  .items-table th:first-child{border-top-left-radius:8px;border-bottom-left-radius:8px;}
  .items-table th:last-child{border-top-right-radius:8px;border-bottom-right-radius:8px;text-align:right;}
  .items-table td{padding:16px;font-size:13px;color:#4a5568;border-bottom:1px solid #edf2f7;vertical-align:top;}
  .items-table td:last-child{text-align:right;}
  .totals-section{display:flex;justify-content:flex-end;margin-bottom:40px;}
  .totals-box{width:280px;}
  .totals-row{display:flex;justify-content:space-between;padding:10px 16px;font-size:14px;}
  .t-label{color:#718096;}
  .t-value{color:#2d3748;font-weight:700;}
  .totals-row.grand{background:#6b46c1;border-radius:12px;margin-top:10px;padding:16px;}
  .totals-row.grand .t-label{color:#e9d8fd;}
  .totals-row.grand .t-value{font-size:20px;color:#fff;}
  .voucher-section{background:#f9f5ff;border-radius:16px;padding:30px;margin-bottom:40px;}
  .voucher-row{display:flex;justify-content:space-between;padding:12px 0;border-bottom:1px dashed #d6bcfa;}
  .voucher-row:last-child{border-bottom:none;}
  .voucher-label{font-size:11px;font-weight:bold;color:#6b46c1;text-transform:uppercase;letter-spacing:1px;}
  .voucher-value{font-size:14px;color:#2d3748;font-weight:800;}
  .amount-highlight{font-size:24px;color:#6b46c1;}
  .remark-section{background:#fffaf0;border-radius:12px;padding:20px;margin-bottom:40px;}
  .remark-label{font-size:11px;font-weight:bold;color:#dd6b20;text-transform:uppercase;margin-bottom:6px;}
  .remark-text{font-size:12px;color:#7b341e;line-height:1.6;}
  .footer{position:absolute;bottom:0;width:100%;padding:24px 48px;display:flex;justify-content:space-between;font-size:11px;color:#a0aec0;}
  .footer-brand{font-weight:800;color:#6b46c1;}
    `,
    minimal: `
  *{box-sizing:border-box;margin:0;padding:0;}
  body{font-family:sans-serif;font-size:12px;color:#000;background:#fff;width:794px;}
  .page{width:794px;min-height:1123px;padding:50px;position:relative;}
  .header{margin-bottom:40px;}
  .company-name{font-size:18px;font-weight:bold;margin-bottom:4px;text-transform:uppercase;}
  .company-details{font-size:11px;color:#555;line-height:1.4;}
  .invoice-type-label{font-size:24px;font-weight:normal;text-transform:lowercase;letter-spacing:1px;margin-top:20px;margin-bottom:5px;}
  .invoice-num-val{font-size:14px;color:#000;}
  .invoice-num-label{font-size:10px;text-transform:uppercase;color:#888;}
  .meta-strip{display:flex;gap:30px;margin-bottom:40px;}
  .meta-label{font-size:9px;text-transform:uppercase;color:#888;margin-bottom:2px;}
  .meta-value{font-size:12px;}
  .body{}
  .party-section{display:flex;gap:30px;margin-bottom:40px;}
  .party-card{flex:1;}
  .party-card-label{font-size:9px;text-transform:uppercase;color:#888;margin-bottom:4px;border-bottom:1px solid #000;padding-bottom:2px;display:inline-block;}
  .party-name{font-size:14px;font-weight:bold;margin-bottom:2px;margin-top:8px;}
  .party-detail{font-size:11px;color:#555;line-height:1.4;}
  .table-title{display:none;}
  .items-table{width:100%;border-collapse:collapse;margin-bottom:40px;}
  .items-table th{padding:8px 0;font-size:10px;text-transform:uppercase;border-bottom:1px solid #000;text-align:left;}
  .items-table td{padding:12px 0;font-size:12px;border-bottom:1px solid #eee;vertical-align:top;}
  .items-table th:last-child, .items-table td:last-child{text-align:right;}
  .totals-section{display:flex;justify-content:flex-end;margin-bottom:40px;}
  .totals-box{width:200px;}
  .totals-row{display:flex;justify-content:space-between;padding:6px 0;}
  .t-label{color:#555;}
  .t-value{color:#000;}
  .totals-row.grand{border-top:1px solid #000;margin-top:4px;padding-top:8px;}
  .totals-row.grand .t-label{font-weight:bold;}
  .totals-row.grand .t-value{font-weight:bold;font-size:14px;}
  .voucher-section{margin-bottom:40px;}
  .voucher-row{display:flex;justify-content:space-between;padding:8px 0;border-bottom:1px solid #eee;}
  .voucher-row:first-child{border-top:1px solid #000;}
  .voucher-row:last-child{border-bottom:1px solid #000;}
  .voucher-label{font-size:10px;text-transform:uppercase;color:#888;}
  .voucher-value{font-size:12px;}
  .amount-highlight{font-size:16px;font-weight:bold;}
  .remark-section{margin-bottom:40px;color:#555;font-size:11px;}
  .remark-label{font-size:9px;text-transform:uppercase;color:#888;margin-bottom:4px;}
  .remark-text{line-height:1.4;}
  .footer{position:absolute;bottom:50px;left:50px;right:50px;display:flex;justify-content:space-between;font-size:9px;color:#888;}
    `,
    compact: `
  *{box-sizing:border-box;margin:0;padding:0;}
  body{font-family:'Segoe UI',Arial,sans-serif;font-size:10px;color:#222;background:#fff;width:794px;}
  .page{width:794px;min-height:1123px;padding:30px;position:relative;}
  .header{display:flex;justify-content:space-between;border-bottom:2px solid #555;padding-bottom:10px;margin-bottom:15px;}
  .company-name{font-size:16px;font-weight:bold;color:#000;margin-bottom:2px;}
  .company-details{font-size:9px;color:#444;}
  .invoice-type-label{font-size:14px;font-weight:bold;text-transform:uppercase;color:#222;}
  .invoice-num-val{font-size:12px;font-weight:bold;}
  .invoice-num-label{font-size:9px;color:#666;text-transform:uppercase;}
  .meta-strip{display:flex;gap:20px;margin-bottom:15px;}
  .meta-item{flex:1;border:1px solid #ccc;padding:6px 10px;background:#f9f9f9;}
  .meta-label{font-size:8px;font-weight:bold;color:#666;text-transform:uppercase;}
  .meta-value{font-size:11px;font-weight:bold;}
  .party-section{display:flex;gap:20px;margin-bottom:15px;}
  .party-card{flex:1;border:1px solid #ccc;padding:10px;}
  .party-card-label{font-size:8px;font-weight:bold;color:#666;text-transform:uppercase;margin-bottom:4px;}
  .party-name{font-size:12px;font-weight:bold;margin-bottom:2px;}
  .party-detail{font-size:9px;color:#444;}
  .table-title{display:none;}
  .items-table{width:100%;border-collapse:collapse;margin-bottom:15px;border:1px solid #ccc;}
  .items-table th{background:#eee;padding:6px;font-size:9px;border-bottom:1px solid #ccc;border-right:1px solid #ccc;text-align:left;}
  .items-table td{padding:6px;font-size:10px;border-bottom:1px solid #eee;border-right:1px solid #eee;vertical-align:top;}
  .items-table th:last-child, .items-table td:last-child{text-align:right;border-right:none;}
  .totals-section{display:flex;justify-content:flex-end;margin-bottom:15px;}
  .totals-box{width:220px;border:1px solid #ccc;padding:10px;background:#f9f9f9;}
  .totals-row{display:flex;justify-content:space-between;padding:4px 0;}
  .t-label{font-weight:bold;color:#444;}
  .t-value{font-weight:bold;}
  .totals-row.grand{border-top:1px solid #aaa;margin-top:4px;padding-top:6px;}
  .totals-row.grand .t-label{font-size:12px;}
  .totals-row.grand .t-value{font-size:13px;}
  .voucher-section{border:1px solid #ccc;padding:15px;margin-bottom:15px;}
  .voucher-row{display:flex;justify-content:space-between;padding:6px 0;border-bottom:1px solid #eee;}
  .voucher-row:last-child{border-bottom:none;}
  .voucher-label{font-size:9px;font-weight:bold;color:#666;text-transform:uppercase;}
  .voucher-value{font-size:11px;font-weight:bold;}
  .amount-highlight{font-size:14px;color:#000;}
  .remark-section{border:1px dashed #ccc;padding:10px;margin-bottom:15px;}
  .remark-label{font-size:8px;font-weight:bold;color:#666;text-transform:uppercase;margin-bottom:2px;}
  .remark-text{font-size:9px;color:#444;line-height:1.4;}
  .footer{position:absolute;bottom:30px;left:30px;right:30px;display:flex;justify-content:space-between;font-size:8px;color:#777;border-top:1px solid #ccc;padding-top:10px;}
    `,
    professional: `
  *{box-sizing:border-box;margin:0;padding:0;}
  body{font-family:'Trebuchet MS',Arial,sans-serif;font-size:12px;color:#334155;background:#f8fafc;width:794px;}
  .page{width:794px;min-height:1123px;padding:40px;position:relative;background:#fff;}
  .header{display:flex;justify-content:space-between;border-bottom:4px solid #0f172a;padding-bottom:20px;margin-bottom:30px;}
  .company-name{font-size:24px;font-weight:bold;color:#0f172a;margin-bottom:6px;letter-spacing:1px;}
  .company-details{font-size:11px;color:#64748b;line-height:1.6;}
  .invoice-type-label{font-size:14px;font-weight:bold;text-transform:uppercase;color:#475569;letter-spacing:2px;text-align:right;}
  .invoice-num-val{font-size:18px;font-weight:bold;color:#0f172a;margin-top:10px;text-align:right;display:block;}
  .invoice-num-label{font-size:10px;color:#64748b;text-transform:uppercase;}
  .meta-strip{display:flex;justify-content:space-between;background:#f1f5f9;padding:15px 20px;border-radius:4px;margin-bottom:30px;}
  .meta-label{font-size:9px;font-weight:bold;color:#64748b;text-transform:uppercase;margin-bottom:4px;}
  .meta-value{font-size:13px;font-weight:bold;color:#0f172a;}
  .party-section{display:flex;gap:30px;margin-bottom:30px;}
  .party-card{flex:1;}
  .party-card-label{font-size:10px;font-weight:bold;color:#0f172a;text-transform:uppercase;margin-bottom:10px;border-bottom:1px solid #cbd5e1;padding-bottom:5px;}
  .party-name{font-size:15px;font-weight:bold;color:#334155;margin-bottom:4px;}
  .party-detail{font-size:11px;color:#64748b;line-height:1.5;}
  .table-title{display:none;}
  .items-table{width:100%;border-collapse:collapse;margin-bottom:30px;}
  .items-table th{background:#0f172a;color:#fff;padding:12px;font-size:10px;text-transform:uppercase;letter-spacing:1px;text-align:left;}
  .items-table td{padding:14px 12px;font-size:12px;border-bottom:1px solid #e2e8f0;vertical-align:top;}
  .items-table th:last-child, .items-table td:last-child{text-align:right;}
  .items-table tbody tr:nth-child(even){background:#f8fafc;}
  .totals-section{display:flex;justify-content:flex-end;margin-bottom:30px;}
  .totals-box{width:260px;}
  .totals-row{display:flex;justify-content:space-between;padding:8px 0;font-size:13px;}
  .t-label{color:#475569;}
  .t-value{color:#0f172a;font-weight:bold;}
  .totals-row.grand{border-top:2px solid #0f172a;margin-top:8px;padding-top:12px;background:#f1f5f9;padding-left:15px;padding-right:15px;border-radius:4px;}
  .totals-row.grand .t-label{font-size:14px;color:#0f172a;font-weight:bold;}
  .totals-row.grand .t-value{font-size:18px;color:#0f172a;font-weight:bold;}
  .voucher-section{background:#f1f5f9;padding:25px;border-radius:4px;border-left:4px solid #0f172a;margin-bottom:30px;}
  .voucher-row{display:flex;justify-content:space-between;padding:12px 0;border-bottom:1px solid #cbd5e1;}
  .voucher-row:last-child{border-bottom:none;}
  .voucher-label{font-size:11px;font-weight:bold;color:#475569;text-transform:uppercase;letter-spacing:1px;}
  .voucher-value{font-size:13px;font-weight:bold;color:#0f172a;}
  .amount-highlight{font-size:20px;}
  .remark-section{margin-bottom:30px;background:#f8fafc;padding:15px;border:1px solid #e2e8f0;border-radius:4px;}
  .remark-label{font-size:10px;font-weight:bold;color:#475569;text-transform:uppercase;margin-bottom:6px;}
  .remark-text{font-size:11px;color:#64748b;line-height:1.5;}
  .footer{position:absolute;bottom:40px;left:40px;right:40px;display:flex;justify-content:space-between;font-size:10px;color:#94a3b8;border-top:1px solid #e2e8f0;padding-top:15px;}
    `,
    boutique: `
  *{box-sizing:border-box;margin:0;padding:0;}
  body{font-family:'Optima','Segoe UI',sans-serif;font-size:13px;color:#5a5450;background:#faf8f5;width:794px;}
  .page{width:794px;min-height:1123px;padding:50px;position:relative;}
  .header{text-align:center;margin-bottom:40px;}
  .company-name{font-size:26px;font-weight:normal;color:#c08e7b;letter-spacing:3px;margin-bottom:10px;text-transform:uppercase;}
  .company-details{font-size:11px;color:#8c837b;line-height:1.6;letter-spacing:1px;}
  .invoice-type-label{font-size:16px;color:#c08e7b;text-transform:uppercase;letter-spacing:4px;margin-top:30px;margin-bottom:8px;}
  .invoice-num-row{margin-bottom:20px;}
  .invoice-num-label{font-size:10px;color:#aba198;text-transform:uppercase;letter-spacing:1px;margin-right:10px;}
  .invoice-num-val{font-size:14px;color:#5a5450;}
  .meta-strip{display:flex;justify-content:center;gap:40px;margin-bottom:40px;}
  .meta-item{text-align:center;}
  .meta-label{font-size:9px;color:#aba198;text-transform:uppercase;letter-spacing:1px;margin-bottom:6px;}
  .meta-value{font-size:13px;color:#5a5450;}
  .party-section{display:flex;justify-content:space-around;margin-bottom:40px;background:#fff;padding:25px;border-radius:15px;box-shadow:0 4px 15px rgba(192,142,123,0.05);}
  .party-card{text-align:center;max-width:40%;}
  .party-card-label{font-size:9px;color:#c08e7b;text-transform:uppercase;letter-spacing:2px;margin-bottom:10px;}
  .party-name{font-size:15px;color:#5a5450;margin-bottom:6px;}
  .party-detail{font-size:11px;color:#8c837b;line-height:1.5;}
  .table-title{display:none;}
  .items-table{width:100%;border-collapse:collapse;margin-bottom:40px;}
  .items-table th{padding:12px 10px;font-size:10px;color:#aba198;text-transform:uppercase;letter-spacing:1px;border-bottom:1px solid #ebdcd5;text-align:left;}
  .items-table td{padding:16px 10px;font-size:13px;color:#5a5450;border-bottom:1px solid #f2ece8;vertical-align:top;}
  .items-table th:last-child, .items-table td:last-child{text-align:right;}
  .totals-section{display:flex;justify-content:flex-end;margin-bottom:40px;}
  .totals-box{width:280px;background:#fff;padding:20px;border-radius:15px;box-shadow:0 4px 15px rgba(192,142,123,0.05);}
  .totals-row{display:flex;justify-content:space-between;padding:8px 0;}
  .t-label{color:#8c837b;font-size:12px;}
  .t-value{color:#5a5450;font-size:13px;}
  .totals-row.grand{border-top:1px solid #ebdcd5;margin-top:10px;padding-top:15px;}
  .totals-row.grand .t-label{font-size:14px;color:#c08e7b;text-transform:uppercase;letter-spacing:1px;}
  .totals-row.grand .t-value{font-size:18px;color:#c08e7b;}
  .voucher-section{background:#fff;padding:30px;border-radius:15px;box-shadow:0 4px 15px rgba(192,142,123,0.05);margin-bottom:40px;}
  .voucher-row{display:flex;justify-content:space-between;padding:12px 0;border-bottom:1px dashed #ebdcd5;}
  .voucher-row:last-child{border-bottom:none;}
  .voucher-label{font-size:10px;color:#aba198;text-transform:uppercase;letter-spacing:1px;}
  .voucher-value{font-size:13px;color:#5a5450;}
  .amount-highlight{font-size:22px;color:#c08e7b;}
  .remark-section{text-align:center;margin-bottom:40px;max-width:80%;margin-left:auto;margin-right:auto;}
  .remark-label{display:none;}
  .remark-text{font-size:11px;color:#8c837b;line-height:1.6;font-style:italic;}
  .footer{position:absolute;bottom:40px;left:50px;right:50px;text-align:center;font-size:10px;color:#aba198;border-top:1px solid #ebdcd5;padding-top:15px;}
    `
};

const HTML_BODY = `
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1.0"/>
<title>{{type_label}}</title>
<style>
/* CSS_PLACEHOLDER */
</style>
</head>
<body>
<div class="page">
  <div class="header">
    <div class="header-inner">
      <div class="company-block">
        <div class="company-name">{{company_name}}</div>
        <div class="company-details">
          {{company_address}}<br/>
          {{#if company_phone}}Phone: {{company_phone}}{{/if}}{{#if company_phone}}{{#if company_email}} &nbsp;|&nbsp; {{/if}}{{/if}}{{#if company_email}}Email: {{company_email}}{{/if}}
        </div>
      </div>
      <div class="invoice-badge">
        <div class="invoice-type-label">{{type_label}}</div>
        <div class="invoice-number-row">
          <span class="invoice-num-label">Invoice No.</span>
          <span class="invoice-num-val">{{invoice_no}}</span>
        </div>
      </div>
    </div>
  </div>

  <div class="meta-strip">
    <div class="meta-item">
      <div class="meta-label">Issue Date</div>
      <div class="meta-value">{{invoice_date}}</div>
    </div>
    {{#if due_date}}
    <div class="meta-item">
      <div class="meta-label">Due Date</div>
      <div class="meta-value">{{due_date}}</div>
    </div>
    {{/if}}
    <div class="meta-item">
      <div class="meta-label">Amount Due</div>
      <div class="meta-value">{{amount}}</div>
    </div>
    {{#if tax_amount}}
    <div class="meta-item">
      <div class="meta-label">Tax</div>
      <div class="meta-value">{{tax_amount}}</div>
    </div>
    {{/if}}
  </div>

  <div class="body">
    {{#if show_parties}}
    <div class="party-section">
      {{#if party_name}}
      <div class="party-card">
        <div class="party-card-label">{{bill_to_label}}</div>
        <div class="party-name">{{party_name}}</div>
        {{#if party_detail}}<div class="party-detail">{{{party_detail}}}</div>{{/if}}
      </div>
      {{/if}}
      {{#if party2_name}}
      <div class="party-card">
        <div class="party-card-label">{{party2_label}}</div>
        <div class="party-name">{{party2_name}}</div>
        {{#if party2_detail}}<div class="party-detail">{{{party2_detail}}}</div>{{/if}}
      </div>
      {{/if}}
    </div>
    {{/if}}

    {{#if has_items}}
    <div class="table-section">
      <div class="table-title">Items &amp; Services</div>
      <table class="items-table">
        <thead>
          <tr>
            <th style="width:4%">#</th>
            <th style="width:35%">Item / Service</th>
            <th style="width:25%">Description</th>
            <th style="width:12%">Rate</th>
            <th style="width:10%">Qty</th>
            <th style="width:14%">Amount</th>
          </tr>
        </thead>
        <tbody>
          {{{items_rows}}}
        </tbody>
      </table>
    </div>
    <div class="totals-section">
      <div class="totals-box">
        {{#if tax_amount}}
        <div class="totals-row">
          <span class="t-label">Subtotal</span>
          <span class="t-value">{{subtotal}}</span>
        </div>
        <div class="totals-row">
          <span class="t-label">Tax</span>
          <span class="t-value">{{tax_amount}}</span>
        </div>
        {{/if}}
        <div class="totals-row grand">
          <span class="t-label">Total Amount</span>
          <span class="t-value">{{amount}}</span>
        </div>
      </div>
    </div>
    {{/if}}

    {{#if is_simple}}
    <div class="voucher-section">
      <div class="voucher-row">
        <span class="voucher-label">Transaction Reference</span>
        <span class="voucher-value">{{invoice_no}}</span>
      </div>
      {{#if party_name}}
      <div class="voucher-row">
        <span class="voucher-label">{{bill_to_label}}</span>
        <span class="voucher-value">{{party_name}}</span>
      </div>
      {{/if}}
      {{#if party2_name}}
      <div class="voucher-row">
        <span class="voucher-label">{{party2_label}}</span>
        <span class="voucher-value">{{party2_name}}</span>
      </div>
      {{/if}}
      <div class="voucher-row" style="margin-top:8px;padding-top:16px;">
        <span class="voucher-label">Total Amount</span>
        <span class="amount-highlight">{{amount}}</span>
      </div>
    </div>
    {{/if}}

    {{#if remark}}
    <div class="remark-section">
      <div class="remark-label">Remarks</div>
      <div class="remark-text">{{remark}}</div>
    </div>
    {{/if}}
  </div>

  <div class="footer">
    <div class="footer-left">
      <span class="footer-brand">{{company_name}}</span><br/>
      This is a computer-generated document.
    </div>
    <div class="footer-right">
      Generated on {{generated_date}}<br/>
      Page 1
    </div>
  </div>
</div>
</body>
</html>
`;

function generate() {
    for (const [type, variants] of Object.entries(MAPPING)) {
        const typeDir = path.join(__dirname, '..', 'templates', 'format', type);
        fs.mkdirSync(typeDir, { recursive: true });
        
        // Remove existing files in the directory to clean up old formats
        const existingFiles = fs.readdirSync(typeDir);
        for (const file of existingFiles) {
            if (file.endsWith('.html')) {
                fs.unlinkSync(path.join(typeDir, file));
            }
        }

        for (const variant of variants) {
            if (!THEMES[variant]) {
                console.warn(`Theme for variant ${variant} not defined!`);
                continue;
            }
            const htmlContent = HTML_BODY.replace('/* CSS_PLACEHOLDER */', THEMES[variant]);
            fs.writeFileSync(path.join(typeDir, `${variant}.html`), htmlContent);
            console.log(`Generated ${type}/${variant}.html`);
        }
    }
}

generate();
