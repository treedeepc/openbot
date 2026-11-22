import type { OpenBotMigration } from "./migration";

export const IM_SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS peers (
    peer_server_id TEXT NOT NULL, peer_agent_id TEXT NOT NULL,
    public_key TEXT NOT NULL, display_name TEXT NOT NULL,
    verified_at INTEGER, first_seen_at INTEGER NOT NULL, last_seen_at INTEGER,
    PRIMARY KEY (peer_server_id, peer_agent_id)
  );
  CREATE UNIQUE INDEX IF NOT EXISTS peers_public_key_uq ON peers(public_key);
  CREATE TABLE IF NOT EXISTS directory_profiles (
    peer_server_id TEXT NOT NULL, peer_agent_id TEXT NOT NULL,
    display_name TEXT NOT NULL, bio TEXT, avatar TEXT, updated_at INTEGER NOT NULL,
    PRIMARY KEY (peer_server_id, peer_agent_id)
  );
  CREATE TABLE IF NOT EXISTS presence (
    peer_server_id TEXT NOT NULL, peer_agent_id TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('online','away','offline')),
    hidden INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL,
    PRIMARY KEY (peer_server_id, peer_agent_id)
  );
  CREATE TABLE IF NOT EXISTS local_devices (
    local_server_id TEXT NOT NULL, local_member_id TEXT NOT NULL, device_id TEXT NOT NULL,
    public_key TEXT NOT NULL, status TEXT NOT NULL CHECK (status IN ('pending','active','revoked')),
    cert_ref TEXT, enrolled_at INTEGER, revoked_at INTEGER, pairing_expires_at INTEGER,
    PRIMARY KEY (local_server_id, local_member_id, device_id)
  );
  CREATE UNIQUE INDEX IF NOT EXISTS local_devices_pk_uq ON local_devices(local_server_id, local_member_id, public_key);
  CREATE TABLE IF NOT EXISTS peers_devices (
    device_id TEXT NOT NULL, peer_server_id TEXT NOT NULL, peer_agent_id TEXT NOT NULL,
    public_key TEXT NOT NULL, cert_ref TEXT NOT NULL, endorsed_by TEXT NOT NULL, revoked_at INTEGER,
    PRIMARY KEY (device_id),
    UNIQUE (peer_server_id, peer_agent_id, public_key)
  );
  CREATE TABLE IF NOT EXISTS causal_chains (
    chain_id TEXT PRIMARY KEY, root_message_id TEXT NOT NULL,
    trust_domain TEXT NOT NULL, created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS im_threads (
    local_server_id TEXT NOT NULL, local_member_id TEXT NOT NULL, thread_id TEXT NOT NULL,
    peer_server_id TEXT NOT NULL, peer_agent_id TEXT NOT NULL,
    state TEXT NOT NULL, last_message_at INTEGER,
    PRIMARY KEY (thread_id),
    UNIQUE (local_server_id, local_member_id, peer_server_id, peer_agent_id),
    UNIQUE (thread_id, local_server_id, local_member_id)
  );
  CREATE TABLE IF NOT EXISTS im_thread_assignees (
    local_server_id TEXT NOT NULL, local_member_id TEXT NOT NULL,
    thread_id TEXT NOT NULL, agent_id TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('primary','assist')),
    PRIMARY KEY (local_server_id, local_member_id, thread_id, agent_id),
    FOREIGN KEY (thread_id, local_server_id, local_member_id) REFERENCES im_threads(thread_id, local_server_id, local_member_id)
  );
  CREATE UNIQUE INDEX IF NOT EXISTS im_thread_primary_uq
    ON im_thread_assignees(thread_id) WHERE role = 'primary';
  CREATE TABLE IF NOT EXISTS im_messages (
    local_server_id TEXT NOT NULL, local_member_id TEXT NOT NULL,
    local_message_id TEXT NOT NULL,
    thread_id TEXT NOT NULL,
    remote_message_id TEXT NOT NULL,
    peer_server_id TEXT NOT NULL, peer_agent_id TEXT NOT NULL,
    sender_kind TEXT NOT NULL CHECK (sender_kind IN ('self','local-assistant','peer')),
    sender_agent_id TEXT, device_id TEXT,
    body TEXT NOT NULL, attachments_digest TEXT,
    proxied_by TEXT, proxy_visibility TEXT CHECK (proxy_visibility IN ('shown','hidden')),
    causal_chain_id TEXT, reply_to TEXT,
    nonce TEXT NOT NULL, signature TEXT NOT NULL, verified INTEGER NOT NULL,
    sent_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, withdrawn_at INTEGER,
    PRIMARY KEY (local_message_id),
    UNIQUE (local_server_id, local_member_id, peer_server_id, peer_agent_id, remote_message_id),
    UNIQUE (local_message_id, local_server_id, local_member_id),
    FOREIGN KEY (thread_id, local_server_id, local_member_id) REFERENCES im_threads(thread_id, local_server_id, local_member_id)
  );
  CREATE INDEX IF NOT EXISTS im_messages_thread_time ON im_messages(thread_id, sent_at);
  CREATE TABLE IF NOT EXISTS im_attachments (
    local_server_id TEXT NOT NULL, local_member_id TEXT NOT NULL,
    attachment_id TEXT NOT NULL, local_message_id TEXT NOT NULL,
    file_name TEXT NOT NULL, size INTEGER NOT NULL, digest TEXT NOT NULL,
    storage_key TEXT NOT NULL, created_at INTEGER NOT NULL, deleted_at INTEGER,
    PRIMARY KEY (attachment_id),
    UNIQUE (local_message_id, digest),
    FOREIGN KEY (local_message_id, local_server_id, local_member_id) REFERENCES im_messages(local_message_id, local_server_id, local_member_id)
  );
  CREATE TABLE IF NOT EXISTS im_deliveries (
    local_server_id TEXT NOT NULL, local_member_id TEXT NOT NULL,
    delivery_id TEXT NOT NULL, local_message_id TEXT NOT NULL,
    peer_server_id TEXT NOT NULL, peer_agent_id TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('submitted','persisted','acked','read','blocked-discarded','failed')),
    attempts INTEGER NOT NULL DEFAULT 0, next_retry_at INTEGER,
    created_at INTEGER NOT NULL, acked_at INTEGER, error TEXT,
    PRIMARY KEY (delivery_id),
    UNIQUE (local_message_id, peer_server_id, peer_agent_id),
    FOREIGN KEY (local_message_id, local_server_id, local_member_id) REFERENCES im_messages(local_message_id, local_server_id, local_member_id)
  );
  CREATE TABLE IF NOT EXISTS message_dedup (
    local_server_id TEXT NOT NULL, local_member_id TEXT NOT NULL,
    peer_server_id TEXT NOT NULL, peer_agent_id TEXT NOT NULL,
    remote_message_id TEXT NOT NULL, device_id TEXT NOT NULL, nonce TEXT NOT NULL,
    received_at INTEGER NOT NULL,
    UNIQUE (local_server_id, local_member_id, peer_server_id, peer_agent_id, remote_message_id, device_id, nonce)
  );
  CREATE TABLE IF NOT EXISTS contacts (
    local_server_id TEXT NOT NULL, local_member_id TEXT NOT NULL, contact_id TEXT NOT NULL,
    peer_server_id TEXT NOT NULL, peer_agent_id TEXT NOT NULL,
    alias TEXT, state TEXT NOT NULL CHECK (state IN ('pending','accepted','removed')),
    added_at INTEGER NOT NULL, source TEXT, updated_at INTEGER NOT NULL,
    PRIMARY KEY (local_server_id, local_member_id, contact_id),
    UNIQUE (local_server_id, local_member_id, peer_server_id, peer_agent_id)
  );
  CREATE TABLE IF NOT EXISTS block_rules (
    local_server_id TEXT NOT NULL, local_member_id TEXT NOT NULL, rule_id TEXT NOT NULL,
    peer_server_id TEXT NOT NULL, peer_agent_id TEXT NOT NULL,
    created_at INTEGER NOT NULL, reason TEXT,
    PRIMARY KEY (local_server_id, local_member_id, rule_id),
    UNIQUE (local_server_id, local_member_id, peer_server_id, peer_agent_id)
  );
  CREATE TABLE IF NOT EXISTS contact_requests (
    local_server_id TEXT NOT NULL, local_member_id TEXT NOT NULL, request_id TEXT NOT NULL,
    direction TEXT NOT NULL CHECK (direction IN ('inbound','outbound')),
    peer_server_id TEXT NOT NULL, peer_agent_id TEXT NOT NULL,
    message TEXT, created_at INTEGER NOT NULL, resolved_at INTEGER, attempts INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (local_server_id, local_member_id, request_id)
  );
  CREATE TABLE IF NOT EXISTS read_state (
    local_server_id TEXT NOT NULL, local_member_id TEXT NOT NULL, thread_id TEXT NOT NULL,
    last_read_local_message_id TEXT, updated_at INTEGER NOT NULL,
    PRIMARY KEY (local_server_id, local_member_id, thread_id),
    FOREIGN KEY (thread_id, local_server_id, local_member_id) REFERENCES im_threads(thread_id, local_server_id, local_member_id)
  );
  CREATE TABLE IF NOT EXISTS notification_defaults (
    local_server_id TEXT NOT NULL, local_member_id TEXT NOT NULL,
    notify_on TEXT NOT NULL CHECK (notify_on IN ('all','mentions','none')),
    show_preview INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (local_server_id, local_member_id)
  );
  CREATE TABLE IF NOT EXISTS notification_overrides (
    local_server_id TEXT NOT NULL, local_member_id TEXT NOT NULL, thread_id TEXT NOT NULL,
    muted_until INTEGER, notify_on TEXT CHECK (notify_on IN ('all','mentions','none')),
    show_preview INTEGER,
    PRIMARY KEY (local_server_id, local_member_id, thread_id),
    FOREIGN KEY (thread_id, local_server_id, local_member_id) REFERENCES im_threads(thread_id, local_server_id, local_member_id)
  );
  CREATE TABLE IF NOT EXISTS withdrawn_messages (
    local_server_id TEXT NOT NULL, local_member_id TEXT NOT NULL, local_message_id TEXT NOT NULL,
    withdrawn_at INTEGER NOT NULL, withdrawn_by TEXT NOT NULL, tombstone_text TEXT NOT NULL,
    PRIMARY KEY (local_server_id, local_member_id, local_message_id),
    FOREIGN KEY (local_message_id, local_server_id, local_member_id) REFERENCES im_messages(local_message_id, local_server_id, local_member_id)
  );
  CREATE TABLE IF NOT EXISTS im_reports (
    local_server_id TEXT NOT NULL, local_member_id TEXT NOT NULL, report_id TEXT NOT NULL,
    target_peer TEXT NOT NULL, category TEXT NOT NULL, detail TEXT,
    status TEXT NOT NULL CHECK (status IN ('open','reviewed','actioned','dismissed')),
    created_at INTEGER NOT NULL, resolved_at INTEGER,
    PRIMARY KEY (local_server_id, local_member_id, report_id)
  );
  CREATE TABLE IF NOT EXISTS audit_log (
    local_server_id TEXT NOT NULL, local_member_id TEXT NOT NULL, id TEXT NOT NULL,
    actor_id TEXT NOT NULL, source_trust_domain TEXT NOT NULL,
    action TEXT NOT NULL, target_id TEXT NOT NULL, result TEXT NOT NULL,
    correlation_id TEXT NOT NULL, before TEXT, after TEXT, at INTEGER NOT NULL, redacted_detail TEXT,
    PRIMARY KEY (local_server_id, local_member_id, id)
  );
  CREATE INDEX IF NOT EXISTS audit_correlation ON audit_log(local_server_id, local_member_id, correlation_id);
  CREATE INDEX IF NOT EXISTS audit_at ON audit_log(local_server_id, local_member_id, at);
  CREATE TABLE IF NOT EXISTS audit_aggregates (
    local_server_id TEXT NOT NULL, local_member_id TEXT NOT NULL,
    bucket TEXT NOT NULL,
    actor_id TEXT NOT NULL, action TEXT NOT NULL, target_id TEXT NOT NULL,
    result TEXT NOT NULL, count INTEGER NOT NULL, first_at INTEGER NOT NULL, last_at INTEGER NOT NULL,
    summary TEXT,
    PRIMARY KEY (local_server_id, local_member_id, bucket, actor_id, action, target_id, result)
  );
  CREATE TABLE IF NOT EXISTS offline_targets (
    local_server_id TEXT NOT NULL, local_member_id TEXT NOT NULL,
    peer_server_id TEXT NOT NULL, peer_agent_id TEXT NOT NULL,
    remote_message_id TEXT NOT NULL,
    recipient_device_id TEXT NOT NULL,
    snapshot_at INTEGER NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('pending','acked','excluded')),
    acked_at INTEGER, excluded_at INTEGER, audit_id TEXT,
    PRIMARY KEY (local_server_id, local_member_id, peer_server_id, peer_agent_id, remote_message_id, recipient_device_id),
    FOREIGN KEY (local_server_id, local_member_id, recipient_device_id)
      REFERENCES local_devices(local_server_id, local_member_id, device_id)
  );
  CREATE INDEX IF NOT EXISTS offline_targets_done ON offline_targets(local_server_id, local_member_id, peer_server_id, peer_agent_id, remote_message_id, state);
  CREATE TABLE IF NOT EXISTS offline_queue (
    local_server_id TEXT NOT NULL, local_member_id TEXT NOT NULL, queue_id TEXT NOT NULL,
    peer_server_id TEXT NOT NULL, peer_agent_id TEXT NOT NULL, recipient_device_id TEXT NOT NULL,
    remote_message_id TEXT NOT NULL,
    sealed_payload BLOB NOT NULL,
    seq INTEGER NOT NULL, expires_at INTEGER NOT NULL, acked_at INTEGER,
    PRIMARY KEY (local_server_id, local_member_id, queue_id),
    UNIQUE (local_server_id, local_member_id, peer_server_id, peer_agent_id, recipient_device_id, remote_message_id),
    FOREIGN KEY (local_server_id, local_member_id, recipient_device_id)
      REFERENCES local_devices(local_server_id, local_member_id, device_id)
  );
  CREATE INDEX IF NOT EXISTS offline_queue_expiry ON offline_queue(expires_at);
  CREATE INDEX IF NOT EXISTS offline_queue_ack ON offline_queue(local_server_id, local_member_id, peer_server_id, peer_agent_id, remote_message_id, acked_at);
`;

export const IM_TABLES_AFTER_MIGRATION: Record<string, never[]> = {
  peers: [],
  directory_profiles: [],
  presence: [],
  local_devices: [],
  peers_devices: [],
  causal_chains: [],
  im_threads: [],
  im_thread_assignees: [],
  im_messages: [],
  im_attachments: [],
  im_deliveries: [],
  message_dedup: [],
  contacts: [],
  block_rules: [],
  contact_requests: [],
  read_state: [],
  notification_defaults: [],
  notification_overrides: [],
  withdrawn_messages: [],
  im_reports: [],
  audit_log: [],
  audit_aggregates: [],
  offline_targets: [],
  offline_queue: [],
};

export const migration: OpenBotMigration = {
  version: 67,
  name: "im",
  up: (db) => db.exec(IM_SCHEMA_SQL),
};
