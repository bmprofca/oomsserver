import moment from "moment";
import pool from "../db.js";

const RANDOM_STRING = (length = 30) => {
    const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
    let randomPart = '';

    for (let i = 0; i < length; i++) {
        randomPart += chars.charAt(Math.floor(Math.random() * chars.length));
    }

    const timestamp = new Date().getTime().toString();
    const final = randomPart + timestamp;

    const shuffled = final
        .split('')
        .sort(() => Math.random() - 0.5)
        .join('');

    return shuffled;
};

const RANDOM_INTEGER = (length = 6) => {
    if (!length || length < 1) return 0;

    const min = Math.pow(10, length - 1);
    const max = Math.pow(10, length) - 1;

    return Math.floor(min + Math.random() * (max - min + 1));
}

const FORMAT_DATE = (date) => {
    if (!date) return null;
    const d = new Date(date);

    const pad = (n) => String(n).padStart(2, "0");

    return (
        d.getFullYear() + "-" +
        pad(d.getMonth() + 1) + "-" +
        pad(d.getDate()) + " " +
        pad(d.getHours()) + ":" +
        pad(d.getMinutes()) + ":" +
        pad(d.getSeconds())
    );
}


const TODAY_DATE = () => {
    return moment().format("YYYY-MM-DD")
}

function GENERATE_PASSWORD(length = 8) {
    const upper = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
    const lower = "abcdefghijklmnopqrstuvwxyz";
    const numbers = "0123456789";
    const special = "@#%";
    const allChars = upper + lower + numbers + special;

    let password = "";

    // Ensure at least one of each type
    password += upper[Math.floor(Math.random() * upper.length)];
    password += lower[Math.floor(Math.random() * lower.length)];
    password += numbers[Math.floor(Math.random() * numbers.length)];
    password += special[Math.floor(Math.random() * special.length)];

    while (password.length < length) {
        password += allChars[Math.floor(Math.random() * allChars.length)];
    }

    password = password.split("").sort(() => Math.random() - 0.5).join("");

    return password;
}

function IS_STRONG_PASSWORD(password) {
    const regex = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[@$!%*?&])[A-Za-z\d@$!%*?&]{8,}$/;
    return regex.test(password);
}

function TIMESTAMP() {
    return moment().format("YYYY-MM-DD HH:mm:ss");
}

async function USER_DATA(username = '') {
    const [row] = await pool.query("SELECT * FROM profile WHERE username = ? AND status = '1' ORDER BY id DESC LIMIT 1", [username]);
    if (row.length == 1) {
        return row[0];
    } else {
        return {};
    }
}

async function SET_OPENING_BALANCE({
    req = {},
    type = "0",
    party_type = "",
    party_id = "",
    amount = 0,
    remark = "",
    transaction_date = moment().format("YYYY-MM-DD")
}) {
    const username = req?.headers["username"] || "";
    const branch_id = req?.branch_id || "";

    const connection = await pool.getConnection();

    try {
        await connection.beginTransaction();

        const transaction_id = RANDOM_STRING(30);
        const invoice_id = RANDOM_STRING(30);

        // CHECK INVOICE PREFIX (IF not exist then throw error)

        const [invoice_prefix] = await connection.query(
            "SELECT * FROM `invoice_prefix` WHERE `branch_id` = ? AND `type` = ? AND `is_deleted` = ? AND `issue_date` <= ? AND `expire_date` >= ?",
            [branch_id, "opening balance", "0", TODAY_DATE(), TODAY_DATE()]
        );



        if (invoice_prefix.length == 0) {
            throw new Error("Invoice prefix not set.");
        }

        const invoice_data = invoice_prefix[0];
        const invoice_primary_id = invoice_data?.id;
        const serial = Number(invoice_data?.current || 0) + 1;

        const invoice_no = `${invoice_data?.prefix}${serial}`


        const absAmount = Math.abs(Number(amount));
        await connection.query(
            "INSERT INTO `invoice` (`invoice_id`, `branch_id`, `invoice_no`, `create_by`, `modify_by`, `type`, `transaction_id`, `subtotal`, `discount_type`, `discount_perc_rate`, `discount_value`, `tax_rate`, `tax_value`, `additional_charge`, `total`, `round_off`, `grand_total`) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
            [invoice_id, branch_id, invoice_no, username, username, "opening balance", transaction_id, absAmount, "not applicable", 0, 0, 0, 0, 0, absAmount, 0, absAmount]
        );

        // Opening balance: use signed amount (positive=debit, negative=credit). Only one party is stored.
        const signedAmount = type === "1" ? -absAmount : absAmount;
        const remarkVal = remark != null && String(remark).trim() !== "" ? String(remark).trim() : null;
        await connection.query(
            "INSERT INTO `transactions` (`branch_id`, `transaction_id`, `create_by`, `modify_by`, `transaction_date`, `amount`, `transaction_type`, `invoice_id`, `invoice_no`, `party1_type`, `party1_id`, `remark`) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
            [branch_id, transaction_id, username, username, transaction_date, signedAmount, "opening balance", invoice_id, invoice_no, party_type, party_id, remarkVal]
        );

        await connection.query("UPDATE `invoice_prefix` SET `current`= ? WHERE `id` = ?", [serial, invoice_primary_id]);

        await connection.commit();
        return true;

    } catch (error) {
        await connection.rollback();
        throw error;
    } finally {
        connection.release();
    }
}

async function EDIT_OPENING_BALANCE({
    req = {},
    transaction_id = "",
    type = "0",
    party_type = "",
    party_id = "",
    amount = 0,
    remark = "",
    transaction_date = moment().format("YYYY-MM-DD")
}) {
    const username = req?.headers["username"] || req?.headers["Username"] || "";
    const branch_id = req?.branch_id || "";

    if (!transaction_id || !branch_id) {
        throw new Error("transaction_id and branch_id are required.");
    }

    const connection = await pool.getConnection();

    try {
        await connection.beginTransaction();

        const [txRows] = await connection.query(
            "SELECT transaction_id, invoice_id FROM `transactions` WHERE `branch_id` = ? AND `transaction_id` = ? AND `transaction_type` = ? LIMIT 1",
            [branch_id, transaction_id, "opening balance"]
        );

        if (!txRows || txRows.length === 0) {
            throw new Error("Opening balance transaction not found or access denied.");
        }

        const absAmount = Math.abs(Number(amount));
        await connection.query(
            "UPDATE `invoice` SET `modify_by` = ?, `subtotal` = ?, `total` = ?, `grand_total` = ? WHERE `branch_id` = ? AND `transaction_id` = ?",
            [username, absAmount, absAmount, absAmount, branch_id, transaction_id]
        );

        // Opening balance: use signed amount (positive=debit, negative=credit). remark on transactions.
        const signedAmount = type === "1" ? -absAmount : absAmount;
        const remarkVal = remark != null && String(remark).trim() !== "" ? String(remark).trim() : null;
        await connection.query(
            "UPDATE `transactions` SET `modify_by` = ?, `transaction_date` = ?, `amount` = ?, `party1_type` = ?, `party1_id` = ?, `remark` = ? WHERE `branch_id` = ? AND `transaction_id` = ?",
            [username, transaction_date, signedAmount, party_type, party_id, remarkVal, branch_id, transaction_id]
        );

        await connection.commit();
        return true;

    } catch (error) {
        await connection.rollback();
        throw error;
    } finally {
        connection.release();
    }
}

async function GET_BALANCE({
    branch_id = "",
    party_id = "",
    party_type = ""
}) {

    const connection = await pool.getConnection();

    try {
        await connection.beginTransaction();

        // party1=sender (effect=-amount), party2=receiver (effect=+amount). opening balance (party2 null): amount is signed.
        const [rows] = await connection.query(
            `SELECT
                SUM(effect) AS balance,
                SUM(GREATEST(effect, 0)) AS debit,
                SUM(GREATEST(-effect, 0)) AS credit
            FROM (
                SELECT CASE
                    WHEN party1_type = ? AND party1_id = ? THEN (CASE WHEN party2_id IS NULL THEN amount ELSE -amount END)
                    WHEN party2_type = ? AND party2_id = ? THEN amount
                    ELSE 0
                END AS effect
                FROM transactions
                WHERE branch_id = ? AND (party1_type = ? AND party1_id = ? OR party2_type = ? AND party2_id = ?)
            ) t`,
            [party_type, party_id, party_type, party_id, branch_id, party_type, party_id, party_type, party_id]
        );
        const r = rows?.[0];
        let balance = Number(r?.balance ?? 0) || 0;
        const debit = Number(r?.debit ?? 0) || 0;
        const credit = Number(r?.credit ?? 0) || 0;

        await connection.commit();
        return {
            balance,
            debit,
            credit
        };

    } catch (error) {
        await connection.rollback();
        throw error;
    } finally {
        connection.release();
    }
}

async function GET_FIRMS_BY_USERNAME({
    username = "",
    branch_id = ""
}) {
    const [rows] = await pool.query("SELECT * FROM firms WHERE username = ? AND branch_id = ? AND is_deleted = '0' ORDER BY id DESC", [username, branch_id]);

    if (rows.length == 0) {
        return [];
    } else {
        const firm_list = [];
        for (let index = 0; index < rows.length; index++) {
            const element = rows[index];
            const firm_id = element?.firm_id;
            const firm_name = element?.firm_name;
            const firm_type = element?.firm_type;
            const username = element?.username;
            const status = element?.status == "1" ? true : false;
            const create_by_username = element?.create_by;
            const create_date = element?.create_date;
            const modify_by_username = element?.modify_by;
            const modify_date = element?.modify_date;
            const address_line_1 = element?.address_line_1;
            const address_line_2 = element?.address_line_2;
            const city = element?.city;
            const state = element?.state;
            const pincode = element?.pincode;
            const country = element?.country;
            const gst_no = element?.gst_no;
            const pan_no = element?.pan_no;
            const file_no = element?.file_no;
            const cin_no = element?.cin_no;
            const vat_no = element?.vat_no;
            const tan_no = element?.tan_no;

            const create_by = await USER_DATA(create_by_username);
            const modify_by = await USER_DATA(modify_by_username);

            const address = {
                address_line_1,
                address_line_2,
                city,
                state,
                pincode,
                country
            };

            firm_list.push({
                firm_id,
                firm_name,
                firm_type,
                username,
                gst_no,
                pan_no,
                file_no,
                cin_no,
                vat_no,
                tan_no,
                status,
                create_by: {
                    name: create_by?.name,
                    email: create_by?.email,
                    mobile: create_by?.mobile,
                },
                create_date,
                modify_by: {
                    name: modify_by?.name,
                    email: modify_by?.email,
                    mobile: modify_by?.mobile,
                },
                modify_date,
                address
            });
        }
        return firm_list;
    }

}

async function USER_SNIPPED_DATA(username = "") {
    const data = await USER_DATA(username);
    return {
        username,
        name: data?.name,
        email: data?.email,
        mobile: data?.mobile,
        country_code: data?.country_code,
    };
}

async function BANK_SNIPPED_DATA(bank_id = "") {
    const [row] = await pool.query("SELECT * FROM banks WHERE bank_id = ? LIMIT 1", [bank_id]);
    if (row.length > 0) {
        const object = {
            bank_id: row[0].bank_id,
            holder: row[0].holder,
            type: row[0].type,
            remark: row[0].remark,
        };

        if (row[0]?.type != 'cash') {
            object.account_no = row[0].account_no;
            object.ifsc = row[0].ifsc;
            object.branch = row[0].branch;
            object.bank = row[0].bank;
            object.holder = row[0].holder;
        }
        return object;
    }
}

async function CAPITAL_SNIPPED_DATA(capital_id = "") {
    const [row] = await pool.query("SELECT * FROM capitals WHERE capital_id = ? LIMIT 1", [capital_id]);
    if (row.length > 0) {
        return {
            capital_id: row[0].capital_id,
            name: row[0].name,
            remark: row[0].remark,
        };
    }
}

async function SINGLE_FIRM_DATA(firm_id = "") {
    const [row] = await pool.query("SELECT * FROM firms WHERE firm_id = ?", [firm_id]);
    if (row.length > 0) {
        return {
            firm_id: row[0].firm_id,
            firm_name: row[0].firm_name,
            firm_type: row[0].firm_type,
            username: row[0].username,
            gst_no: row[0].gst_no,
            pan_no: row[0].pan_no,
            file_no: row[0].file_no,
            cin_no: row[0].cin_no,
            vat_no: row[0].vat_no,
            tan_no: row[0].tan_no,
            status: row[0].status,
            create_by: row[0].create_by,
            create_date: row[0].create_date,
            modify_by: row[0].modify_by,
            modify_date: row[0].modify_date,
            address: row[0].address,
        };
    }
    return {};
}

async function SINGLE_SERVICE_DATA(service_id = "") {
    const [row] = await pool.query("SELECT * FROM services WHERE service_id = ?", [service_id]);
    if (row.length > 0) {
        const modify_by_user = await USER_SNIPPED_DATA(row[0]?.modify_by);
        const create_by_user = await USER_SNIPPED_DATA(row[0]?.create_by);
        return {
            service_id: row[0]?.service_id,
            name: row[0]?.name,
            description: row[0]?.description,
            status: row[0]?.status == "1",
            create_by: create_by_user,
            modify_by: modify_by_user,
            create_date: row[0]?.create_date,
            modify_date: row[0]?.modify_date,
        };
    }
    return {};
}

async function SINGLE_TASK_STAFF_LIST(task_id = "") {
    const [rows] = await pool.query("SELECT profile.*, task_staffs.assign_id FROM task_staffs JOIN profile ON profile.username = task_staffs.username WHERE task_staffs.task_id = ? AND task_staffs.is_deleted = '0' AND profile.status = '1'", [task_id]);

    const list = [];

    for (let index = 0; index < rows.length; index++) {
        const element = rows[index];
        const object = {
            assign_id: element?.assign_id,
            name: element?.name,
            username: element?.username,
            mobile: element?.mobile,
            country_code: element?.country_code,
            email: element?.email
        };

        list.push(object);
    }

    return list;




}

export {
    RANDOM_STRING,
    GENERATE_PASSWORD,
    IS_STRONG_PASSWORD,
    USER_DATA,
    RANDOM_INTEGER,
    SET_OPENING_BALANCE,
    EDIT_OPENING_BALANCE,
    TODAY_DATE,
    GET_BALANCE,
    FORMAT_DATE,
    GET_FIRMS_BY_USERNAME,
    TIMESTAMP,
    USER_SNIPPED_DATA,
    SINGLE_FIRM_DATA,
    SINGLE_SERVICE_DATA,
    SINGLE_TASK_STAFF_LIST,
    BANK_SNIPPED_DATA,
    CAPITAL_SNIPPED_DATA,
};