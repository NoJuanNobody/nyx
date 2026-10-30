-- Remove the in-app AI agent (AI-53). 'agent_workflow' stays in audit_event_type
-- (Postgres cannot drop enum values; historical audit rows may reference it).
DROP TABLE IF EXISTS "agent_tool_calls";
DROP TABLE IF EXISTS "agent_sessions";
DROP TYPE IF EXISTS "agent_session_status";
