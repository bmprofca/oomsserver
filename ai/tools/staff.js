import * as z from "zod";
import { tableBlock } from "../blocks.js";
import { canSeeAllStaff, limitField, searchString } from "./common.js";

/** search_staff — resolve a person's name to branch members (staff / admins / CAs mapped to the branch). */
export const searchStaff = {
    name: "search_staff",
    description:
        "Find team members (staff and admins) of the current office by name, username, mobile or designation. " +
        "Use this first to resolve a person's name to a username before asking for their tasks or attendance. " +
        "If several people match, ask the user which one they mean.",
    input: z.object({
        search: searchString.optional().describe("Name, username, mobile or designation to match"),
        limit: limitField,
    }).strict(),
    allowed: () => true,
    async handler(ctx, args, { db }) {
        const showContact = canSeeAllStaff(ctx);
        const params = [ctx.branch_id];
        let where = "";
        if (args.search) {
            const pattern = `%${args.search}%`;
            where = "AND (p.name LIKE ? OR bm.username LIKE ? OR IFNULL(bm.designation, '') LIKE ? OR p.mobile LIKE ?)";
            params.push(pattern, pattern, pattern, pattern);
        }
        const [rows] = await db.query(
            `SELECT bm.username, bm.type, bm.designation, p.name, p.mobile, p.email
             FROM branch_mapping bm
             LEFT JOIN profile p ON p.username = bm.username
               AND p.id = (SELECT MAX(p2.id) FROM profile p2 WHERE p2.username = bm.username)
             WHERE bm.branch_id = ?
               AND bm.type IN ('admin', 'staff')
               AND bm.is_deleted = '0' AND bm.status = '1' AND bm.is_accepted = '1'
               ${where}
             ORDER BY p.name ASC, bm.username ASC
             LIMIT ?`,
            [...params, args.limit + 1]
        );
        const truncated = rows.length > args.limit;
        const members = rows.slice(0, args.limit).map((r) => ({
            username: r.username,
            name: r.name || r.username,
            role: r.type,
            designation: r.designation || null,
            ...(showContact ? { mobile: r.mobile || null, email: r.email || null } : {}),
        }));

        const columns = [
            { key: "name", label: "Name" },
            { key: "role", label: "Role", type: "status" },
            { key: "designation", label: "Designation" },
            ...(showContact ? [{ key: "mobile", label: "Mobile" }] : []),
        ];
        return {
            data: { count: members.length, truncated, members },
            blocks: members.length > 1
                ? [tableBlock({ title: "Matching team members", columns, rows: members, truncated })]
                : [],
        };
    },
};

export default [searchStaff];
