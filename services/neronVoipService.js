import mqtt from "mqtt";
import crypto from "crypto";

const enabled = String(process.env.NERON_MQTT_ENABLED || "true").toLowerCase() !== "false";
const brokerUrl = String(process.env.NERON_MQTT_URL || "").trim();
const token = String(process.env.NERON_MQTT_TOKEN || "").trim();
const responseTopic = token ? `device/${token}/api/v1.0/response` : "";
const eventTopic = token ? `device/${token}/api/v1.0/event` : "";
const commandTopic = (subcommand) => `device/${token}/api/v1.0/command/${subcommand}`;
const timeoutMs = Number(process.env.NERON_MQTT_COMMAND_TIMEOUT_MS) || 15000;

let client = null;
let connecting = null;
let eventHandler = null;
const pending = new Map();

function assertConfigured() {
    if (!enabled) throw Object.assign(new Error("Neron VOIP is disabled"), { code: "VOIP_DISABLED" });
    if (!brokerUrl || !token) {
        throw Object.assign(new Error("Neron MQTT configuration is missing"), { code: "VOIP_NOT_CONFIGURED" });
    }
}

function requestId() {
    return crypto.randomBytes(12).toString("hex");
}

function rejectPending(error) {
    for (const item of pending.values()) {
        clearTimeout(item.timer);
        item.reject(error);
    }
    pending.clear();
}

function bindClient(nextClient) {
    nextClient.on("message", (topic, buffer) => {
        let payload;
        try {
            payload = JSON.parse(buffer.toString("utf8"));
        } catch {
            console.warn("Ignoring invalid Neron MQTT JSON payload");
            return;
        }

        if (topic === responseTopic && payload.request_id) {
            const item = pending.get(String(payload.request_id));
            if (!item) return;
            pending.delete(String(payload.request_id));
            clearTimeout(item.timer);
            if (String(payload.status).toLowerCase() === "success") item.resolve(payload);
            else item.reject(Object.assign(new Error(payload.message || "Neron command failed"), { payload }));
            return;
        }

        if (topic === eventTopic) eventHandler?.(payload);
    });

    nextClient.on("close", () => {
        rejectPending(new Error("Neron MQTT connection closed"));
        client = null;
    });

    nextClient.on("error", (error) => {
        console.error("Neron MQTT error:", error.message);
    });
}

async function ensureConnected() {
    assertConfigured();
    if (client?.connected) return client;
    if (connecting) return connecting;

    connecting = new Promise((resolve, reject) => {
        const options = {
            clientId: process.env.NERON_MQTT_CLIENT_ID || `ooms-${crypto.randomUUID()}`,
            username: process.env.NERON_MQTT_USERNAME || undefined,
            password: process.env.NERON_MQTT_PASSWORD || undefined,
            reconnectPeriod: Number(process.env.NERON_MQTT_RECONNECT_PERIOD_MS) || 5000,
            connectTimeout: Number(process.env.NERON_MQTT_CONNECT_TIMEOUT_MS) || 10000,
            clean: true,
        };
        const nextClient = mqtt.connect(brokerUrl, options);
        const onConnect = async () => {
            try {
                await new Promise((subscribeResolve, subscribeReject) => {
                    nextClient.subscribe([responseTopic, eventTopic], { qos: 1 }, (error) =>
                        error ? subscribeReject(error) : subscribeResolve());
                });
                client = nextClient;
                bindClient(nextClient);
                resolve(nextClient);
            } catch (error) {
                nextClient.end(true);
                reject(error);
            }
        };
        nextClient.once("connect", onConnect);
        nextClient.once("error", reject);
    }).finally(() => {
        connecting = null;
    });

    return connecting;
}

export function setNeronEventHandler(handler) {
    eventHandler = typeof handler === "function" ? handler : null;
}

export async function sendNeronCommand(subcommand, payload) {
    const connection = await ensureConnected();
    const request_id = payload.request_id || requestId();
    const message = JSON.stringify({ ...payload, request_id });

    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            pending.delete(request_id);
            reject(Object.assign(new Error("Neron command timed out"), { code: "VOIP_PROVIDER_TIMEOUT" }));
        }, timeoutMs);
        pending.set(request_id, { resolve, reject, timer });
        connection.publish(commandTopic(subcommand), message, { qos: 1 }, (error) => {
            if (!error) return;
            clearTimeout(timer);
            pending.delete(request_id);
            reject(error);
        });
    });
}

export async function dial({ caller, callee, autoanswer, dialpermission }) {
    const payload = { cmd: "dial", caller, callee };
    if (autoanswer) payload.autoanswer = autoanswer;
    if (dialpermission) payload.dialpermission = dialpermission;
    return sendNeronCommand("call", payload);
}

export async function hangup({ callid, channelid }) {
    return sendNeronCommand("call", {
        cmd: "hangup",
        ...(channelid ? { channelid } : { callid }),
    });
}

export async function getLiveCalls() {
    return sendNeronCommand("system", { cmd: "livecall" });
}

export function getNeronStatus() {
    return {
        enabled,
        configured: Boolean(brokerUrl && token),
        connected: Boolean(client?.connected),
    };
}
