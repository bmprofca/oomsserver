/**
 * Client document type options for IT / GST / MCA uploads.
 * Used by staff client profile and client portal document APIs.
 * Edit this file to add or change type labels and values.
 */
export const CLIENT_DOCUMENT_TYPES = {
    it: [
        { name: "Full Set", value: "full_set" },
        { name: "ITR-V (Acknowledgement)", value: "itr_v_acknowledgement" },
        { name: "Computation", value: "computation" },
        { name: "B/L & P/L Account", value: "bl_pl_account" },
        { name: "Challan", value: "challan" },
        { name: "Intimation-143", value: "intimation_143" },
        { name: "3CB/3CD", value: "3cb_3cd" },
        { name: "TIS", value: "tis" },
        { name: "AIS", value: "ais" },
        { name: "Others", value: "others" },
    ],
    gst: [
        { name: "GSTR-3B (Monthly)", value: "gstr_3b_monthly" },
        { name: "GSTR-1 (Monthly)", value: "gstr_1_monthly" },
        { name: "GSTR-1 (QRMP)", value: "gstr_1_qrmp" },
        { name: "GSTR-3B (QRMP)", value: "gstr_3b_qrmp" },
        { name: "CMP-08 (Composition)", value: "cmp_08_composition" },
        { name: "GSTR-2B", value: "gstr_2b" },
        { name: "GSTR-9", value: "gstr_9" },
        { name: "GSTR-9C", value: "gstr_9c" },
        { name: "GSTR-04", value: "gstr_04" },
        { name: "GSTR-07", value: "gstr_07" },
        { name: "Others", value: "others" },
    ],
    mca: [
        { name: "B/S and P/L", value: "bs_pl" },
        { name: "Challan", value: "challan" },
        { name: "ADT-4", value: "adt_4" },
        { name: "ADT-1", value: "adt_1" },
        { name: "MGT-7", value: "mgt_7" },
        { name: "DIN", value: "din" },
        { name: "INC-20", value: "inc_20" },
        { name: "AOC-01", value: "aoc_01" },
        { name: "Others", value: "others" },
    ],
};

export default CLIENT_DOCUMENT_TYPES;
