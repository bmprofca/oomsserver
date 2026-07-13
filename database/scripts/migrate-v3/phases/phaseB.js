import { NEW_BRANCH_ID } from "../config.js";
import {
    batchInsert,
    mapIdFor,
    profileIdFor,
    queryBranchRows,
    userTypeToClientType,
    userTypeToMappingType,
} from "../utils.js";

function profileRow(prof, ou, clientType, mappingType) {
    return {
        profile_id: profileIdFor(prof.username),
        username: prof.username,
        create_by: prof.create_by || ou?.username || prof.username,
        user_type: clientType || (mappingType === "admin" ? "admin" : mappingType === "staff" ? "staff" : "user"),
        name: prof.name,
        care_of: prof.guardian_type || null,
        guardian_name: prof.guardian_name || null,
        date_of_birth: prof.dob && !String(prof.dob).startsWith("0000") ? prof.dob : null,
        gender: prof.gender || null,
        mobile: prof.mobile,
        country_code: prof.mobile_country_code ? `+${prof.mobile_country_code}` : "+91",
        email: prof.email,
        state: prof.state,
        district: prof.dist,
        city: prof.town,
        village_town: prof.town,
        pincode: prof.pincode,
        address_line_1: prof.address_line_1,
        address_line_2: prof.address_line_2,
        status: prof.status ?? "1",
        create_date: prof.create_date,
    };
}

export async function runPhaseB(ctx) {
    const { staging, target, logger, dryRun } = ctx;
    logger.info("Phase B: CRM");

    const oldUsers = await queryBranchRows(staging, "users", { reversed: true });
    const profiles = await queryBranchRows(staging, "profile");
    const profileByUsername = new Map(profiles.map((p) => [p.username, p]));
    const userUsernames = new Set(oldUsers.map((u) => u.username));

    const userRows = [];
    const clientRows = [];
    const mappingRows = [];
    const profileRows = [];
    const profileSeen = new Set();

    for (const ou of oldUsers) {
        const mappingType = userTypeToMappingType(ou.user_type);
        const clientType = userTypeToClientType(ou.user_type);
        const isLoginUser = mappingType === "admin" || mappingType === "staff";

        if (isLoginUser) {
            userRows.push({
                username: ou.username,
                create_by: ou.create_by || ou.username,
                status: ou.status ?? "1",
                remark: ou.remark || "",
                create_date: ou.create_date,
            });
            mappingRows.push({
                map_id: mapIdFor(ou.username),
                branch_id: NEW_BRANCH_ID,
                username: ou.username,
                designation: profileByUsername.get(ou.username)?.designation || null,
                create_by: ou.create_by || ou.username,
                modify_by: ou.create_by || ou.username,
                type: mappingType,
                is_accepted: "1",
                invitation_token: null,
                status: "1",
                is_deleted: "0",
                permission_role_id: ou.permission_id || null,
                create_date: ou.create_date,
                modify_date: ou.create_date,
            });
        }

        if (clientType) {
            clientRows.push({
                username: ou.username,
                user_type: clientType,
                branch_id: NEW_BRANCH_ID,
                create_by: ou.create_by || ou.username,
                status: ou.status ?? "1",
                is_deleted: "0",
                create_date: ou.create_date,
            });
            if (ou.user_type === "user") {
                userRows.push({
                    username: ou.username,
                    create_by: ou.create_by || ou.username,
                    status: ou.status ?? "1",
                    remark: ou.remark || "",
                    create_date: ou.create_date,
                });
            }
        }

        const prof = profileByUsername.get(ou.username);
        if (prof && !profileSeen.has(prof.username)) {
            profileRows.push(profileRow(prof, ou, clientType, mappingType));
            profileSeen.add(prof.username);
        }
    }

    for (const prof of profiles) {
        if (userUsernames.has(prof.username) || profileSeen.has(prof.username)) continue;
        profileRows.push(profileRow(prof, null, "client", null));
        profileSeen.add(prof.username);
    }

    const usersInserted = await batchInsert(
        target,
        "users",
        ["username", "create_by", "status", "remark", "create_date"],
        userRows,
        { dryRun }
    );
    const clientsInserted = await batchInsert(
        target,
        "clients",
        ["username", "user_type", "branch_id", "create_by", "status", "is_deleted", "create_date"],
        clientRows,
        { dryRun }
    );
    const mappingsInserted = await batchInsert(
        target,
        "branch_mapping",
        [
            "map_id", "branch_id", "username", "designation", "create_by", "modify_by", "type",
            "is_accepted", "invitation_token", "status", "is_deleted", "permission_role_id",
            "create_date", "modify_date",
        ],
        mappingRows,
        { dryRun }
    );
    const profilesInserted = await batchInsert(
        target,
        "profile",
        [
            "profile_id", "username", "create_by", "user_type", "name", "care_of", "guardian_name",
            "date_of_birth", "gender", "mobile", "country_code", "email", "state", "district", "city",
            "village_town", "pincode", "address_line_1", "address_line_2", "status", "create_date",
        ],
        profileRows,
        { dryRun }
    );

    logger.stat("phaseB.users", usersInserted);
    logger.stat("phaseB.clients", clientsInserted);
    logger.stat("phaseB.branch_mapping", mappingsInserted);
    logger.stat("phaseB.profile", profilesInserted);

    const firms = await queryBranchRows(staging, "firms");
    const firmRows = firms.map((f) => ({
        branch_id: NEW_BRANCH_ID,
        firm_id: f.firm_id,
        username: f.username,
        firm_name: f.firm_name,
        firm_type: f.firm_type,
        pan_no: f.pan,
        gst_no: f.gst,
        tan_no: f.tan,
        vat_no: f.vat,
        cin_no: f.cin,
        file_no: f.file_no,
        state: f.state,
        district: f.dist,
        city: f.town,
        pincode: f.pincode,
        address_line_1: f.address_line_1,
        address_line_2: f.address_line_2,
        create_by: f.create_by,
        modify_by: f.create_by,
        create_date: f.create_date,
        modify_date: f.create_date,
        status: f.status ?? "1",
        is_deleted: "0",
    }));
    const firmsInserted = await batchInsert(
        target,
        "firms",
        [
            "branch_id", "firm_id", "username", "firm_name", "firm_type", "pan_no", "gst_no", "tan_no",
            "vat_no", "cin_no", "file_no", "state", "district", "city", "pincode", "address_line_1",
            "address_line_2", "create_by", "modify_by", "create_date", "modify_date", "status", "is_deleted",
        ],
        firmRows,
        { dryRun }
    );
    logger.stat("phaseB.firms", firmsInserted);

    const groups = await queryBranchRows(staging, "group_id", { reversed: true });
    const groupRows = groups.map((g) => ({
        branch_id: NEW_BRANCH_ID,
        group_id: g.group_id,
        name: g.name,
        remark: g.remark || "",
        create_by: g.create_by,
        modify_by: g.create_by,
        create_date: g.create_date,
        modify_date: g.create_date,
        status: g.status ?? "1",
        is_deleted: "0",
    }));
    const groupsInserted = await batchInsert(
        target,
        "groups",
        ["branch_id", "group_id", "name", "remark", "create_by", "modify_by", "create_date", "modify_date", "status", "is_deleted"],
        groupRows,
        { dryRun }
    );
    logger.stat("phaseB.groups", groupsInserted);

    const groupUsers = await queryBranchRows(staging, "group_users");
    const gfRows = groupUsers.map((gu) => ({
        group_id: gu.group_id,
        firm_id: gu.firm_id,
        unique_id: `${gu.group_id}_${gu.firm_id}_${gu.username}`.slice(0, 100),
        create_by: gu.create_by,
        modify_by: gu.modify_by,
        create_date: gu.create_date,
        modify_date: gu.modify_date,
        is_deleted: "0",
    }));
    const gfInserted = await batchInsert(
        target,
        "group_firms",
        ["group_id", "firm_id", "unique_id", "create_by", "modify_by", "create_date", "modify_date", "is_deleted"],
        gfRows,
        { dryRun }
    );
    logger.stat("phaseB.group_firms", gfInserted);
}
