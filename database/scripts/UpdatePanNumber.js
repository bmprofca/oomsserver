import "dotenv/config";
import pool from "../../db.js";

const UpdatePanNumber = async () => {
    const [clients] = await pool.query(
        `SELECT profile.profile_id, profile.username
         FROM clients
         JOIN profile ON profile.username = clients.username
         WHERE profile.pan_number IS NULL
           AND profile.user_type = 'client'
           AND clients.user_type = 'client'`,
    );

    console.log(`Found ${clients.length} client(s) with null profile.pan_number`);

    let updated = 0;
    let skipped = 0;

    for (let index = 0; index < clients.length; index++) {
        const client = clients[index];
        const profile_id = client.profile_id;
        const username = client.username;

        const firm_pan_number = await getFirmPAN(username);
        if (firm_pan_number) {
            await pool.query("UPDATE profile SET pan_number = ? WHERE profile_id = ?", [
                firm_pan_number,
                profile_id,
            ]);
            updated += 1;
            console.log(`Updated ${username} → ${firm_pan_number}`);
        } else {
            skipped += 1;
        }
    }

    console.log(`Done. Updated: ${updated}, skipped (no firm PAN): ${skipped}`);
};

const getFirmPAN = async (username) => {
    const [firm] = await pool.query(
        `SELECT pan_no
         FROM firms
         WHERE username = ?
           AND (firm_type = 'individual' OR firm_type = 'self')`,
        [username],
    );
    if (firm.length > 0) {
        return firm[0].pan_no || null;
    }
    return null;
};

async function main() {
    try {
        await UpdatePanNumber();
    } finally {
        await pool.end();
    }
}

main().catch((err) => {
    console.error("UpdatePanNumber failed:", err);
    process.exit(1);
});

export default UpdatePanNumber;
