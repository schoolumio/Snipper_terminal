-- Audit log is append-only. UPDATE is always refused; DELETE is refused unless a
-- retention job explicitly opts in for its own transaction with:
--   SET LOCAL sniper.allow_audit_prune = 'on';
CREATE OR REPLACE FUNCTION audit_log_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'audit_log is append-only (UPDATE refused)';
  END IF;
  IF TG_OP = 'DELETE' AND coalesce(current_setting('sniper.allow_audit_prune', true), 'off') <> 'on' THEN
    RAISE EXCEPTION 'audit_log is append-only (DELETE refused outside retention job)';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER audit_log_append_only BEFORE UPDATE OR DELETE ON audit_log FOR EACH ROW EXECUTE FUNCTION audit_log_guard();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION audit_log_guard_truncate() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'audit_log is append-only (TRUNCATE refused)';
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER audit_log_no_truncate BEFORE TRUNCATE ON audit_log FOR EACH STATEMENT EXECUTE FUNCTION audit_log_guard_truncate();
--> statement-breakpoint
-- Agent events are a projection of the audit log.
CREATE VIEW agent_events AS
  SELECT seq, id, ts, agent, action, result, reason, correlation_id, mode FROM audit_log;
--> statement-breakpoint
-- Portfolio snapshots: exposure view over equity snapshots.
CREATE VIEW portfolio_snapshots AS
  SELECT id, mode, ts, equity, cash, reserved, open_liquidation_value, open_mark_value,
         (equity - cash) AS open_exposure_value, open_positions, unvalued_positions, drawdown_pct
  FROM equity_snapshots;
