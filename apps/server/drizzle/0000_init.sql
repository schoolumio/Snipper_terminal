CREATE TABLE "agents" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"role" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL
);
--> statement-breakpoint
CREATE TABLE "alerts" (
	"id" text PRIMARY KEY NOT NULL,
	"ts" bigint NOT NULL,
	"level" text NOT NULL,
	"kind" text NOT NULL,
	"title" text NOT NULL,
	"message" text NOT NULL,
	"mode" text NOT NULL,
	"acknowledged" boolean NOT NULL,
	"correlation_id" text
);
--> statement-breakpoint
CREATE TABLE "audit_log" (
	"seq" bigint PRIMARY KEY NOT NULL,
	"id" text NOT NULL,
	"ts" bigint NOT NULL,
	"correlation_id" text,
	"agent" text NOT NULL,
	"action" text NOT NULL,
	"result" text NOT NULL,
	"mode" text NOT NULL,
	"token_address" text,
	"symbol" text,
	"position_id" text,
	"size_quote" numeric(38, 18),
	"reason" text NOT NULL,
	"metrics" jsonb NOT NULL,
	"config_version" integer NOT NULL,
	"strategy_version" text,
	CONSTRAINT "audit_log_id_unique" UNIQUE("id")
);
--> statement-breakpoint
CREATE TABLE "backtest_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"created_at" bigint NOT NULL,
	"status" text NOT NULL,
	"data_source" text NOT NULL,
	"seed" integer NOT NULL,
	"duration_sec" integer NOT NULL,
	"config_version" integer NOT NULL,
	"stats" jsonb,
	"equity_curve" jsonb NOT NULL,
	"error" text,
	"notes" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "backtest_trades" (
	"id" text PRIMARY KEY NOT NULL,
	"run_id" text NOT NULL,
	"symbol" text NOT NULL,
	"strategy" text NOT NULL,
	"net_pnl" numeric(38, 18) NOT NULL,
	"exit_at" bigint NOT NULL,
	"data" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "candidates" (
	"id" text PRIMARY KEY NOT NULL,
	"chain" text NOT NULL,
	"pool_address" text NOT NULL,
	"token_address" text NOT NULL,
	"symbol" text NOT NULL,
	"stage" text NOT NULL,
	"stage_reason" text,
	"discovered_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL,
	"data" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "equity_snapshots" (
	"id" text PRIMARY KEY NOT NULL,
	"mode" text NOT NULL,
	"ts" bigint NOT NULL,
	"equity" numeric(38, 18) NOT NULL,
	"cash" numeric(38, 18) NOT NULL,
	"reserved" numeric(38, 18) NOT NULL,
	"open_liquidation_value" numeric(38, 18) NOT NULL,
	"open_mark_value" numeric(38, 18) NOT NULL,
	"realized_pnl" numeric(38, 18) NOT NULL,
	"unrealized_pnl" numeric(38, 18) NOT NULL,
	"drawdown_pct" numeric(38, 18) NOT NULL,
	"open_positions" integer NOT NULL,
	"unvalued_positions" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "kv_state" (
	"key" text PRIMARY KEY NOT NULL,
	"value" text NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "liquidity_pools" (
	"chain" text NOT NULL,
	"address" text NOT NULL,
	"dex" text NOT NULL,
	"token_address" text NOT NULL,
	"quote_symbol" text NOT NULL,
	"quote_address" text NOT NULL,
	"created_at" bigint NOT NULL,
	"discovered_at" bigint NOT NULL,
	"source" text NOT NULL,
	"data" jsonb NOT NULL,
	CONSTRAINT "liquidity_pools_chain_address_pk" PRIMARY KEY("chain","address")
);
--> statement-breakpoint
CREATE TABLE "market_snapshots" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "market_snapshots_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"chain" text NOT NULL,
	"pool_address" text NOT NULL,
	"token_address" text NOT NULL,
	"ts" bigint NOT NULL,
	"fetched_at" bigint NOT NULL,
	"source" text NOT NULL,
	"price" numeric(38, 18) NOT NULL,
	"liquidity" numeric(38, 18) NOT NULL,
	"market_cap" numeric(38, 18),
	"data" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "orders" (
	"id" text PRIMARY KEY NOT NULL,
	"idempotency_key" text NOT NULL,
	"mode" text NOT NULL,
	"chain" text NOT NULL,
	"purpose" text NOT NULL,
	"side" text NOT NULL,
	"candidate_id" text NOT NULL,
	"position_id" text,
	"token_address" text NOT NULL,
	"amount_in" numeric(38, 18) NOT NULL,
	"status" text NOT NULL,
	"tx_id" text,
	"created_at" bigint NOT NULL,
	"settled_at" bigint,
	"data" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "position_events" (
	"id" text PRIMARY KEY NOT NULL,
	"position_id" text NOT NULL,
	"ts" bigint NOT NULL,
	"type" text NOT NULL,
	"detail" text NOT NULL,
	"data" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "positions" (
	"id" text PRIMARY KEY NOT NULL,
	"mode" text NOT NULL,
	"chain" text NOT NULL,
	"candidate_id" text NOT NULL,
	"token_address" text NOT NULL,
	"pool_address" text NOT NULL,
	"symbol" text NOT NULL,
	"strategy" text NOT NULL,
	"status" text NOT NULL,
	"cost_basis" numeric(38, 18) NOT NULL,
	"realized_pnl" numeric(38, 18) NOT NULL,
	"opened_at" bigint NOT NULL,
	"closed_at" bigint,
	"data" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "provider_health" (
	"provider" text PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"ok" boolean NOT NULL,
	"last_success_at" bigint,
	"last_error_at" bigint,
	"last_error" text,
	"consecutive_failures" integer NOT NULL,
	"latency_ms" integer
);
--> statement-breakpoint
CREATE TABLE "risk_configurations" (
	"version" integer PRIMARY KEY NOT NULL,
	"risk" jsonb NOT NULL,
	"changed_by" text NOT NULL,
	"changed_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "risk_decisions" (
	"id" text PRIMARY KEY NOT NULL,
	"candidate_id" text NOT NULL,
	"ts" bigint NOT NULL,
	"approved" boolean NOT NULL,
	"size" numeric(38, 18) NOT NULL,
	"max_allowed" numeric(38, 18) NOT NULL,
	"data" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "security_assessments" (
	"id" text PRIMARY KEY NOT NULL,
	"candidate_id" text NOT NULL,
	"chain" text NOT NULL,
	"token_address" text NOT NULL,
	"pool_address" text NOT NULL,
	"ts" bigint NOT NULL,
	"phase" text NOT NULL,
	"verdict" text NOT NULL,
	"risk_score" integer NOT NULL,
	"confidence" real NOT NULL,
	"summary" text NOT NULL,
	"factors" jsonb NOT NULL,
	"config_version" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "strategies" (
	"id" text NOT NULL,
	"version" text NOT NULL,
	"label" text NOT NULL,
	"registered_at" bigint NOT NULL,
	CONSTRAINT "strategies_id_version_pk" PRIMARY KEY("id","version")
);
--> statement-breakpoint
CREATE TABLE "strategy_signals" (
	"id" text PRIMARY KEY NOT NULL,
	"candidate_id" text NOT NULL,
	"strategy" text NOT NULL,
	"strategy_version" text NOT NULL,
	"ts" bigint NOT NULL,
	"score" real NOT NULL,
	"confidence" real NOT NULL,
	"data" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "token_metadata" (
	"chain" text NOT NULL,
	"address" text NOT NULL,
	"name" text NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"updated_at" bigint NOT NULL,
	CONSTRAINT "token_metadata_chain_address_pk" PRIMARY KEY("chain","address")
);
--> statement-breakpoint
CREATE TABLE "tokens" (
	"chain" text NOT NULL,
	"address" text NOT NULL,
	"symbol" text NOT NULL,
	"decimals" integer NOT NULL,
	"first_seen_at" bigint NOT NULL,
	CONSTRAINT "tokens_chain_address_pk" PRIMARY KEY("chain","address")
);
--> statement-breakpoint
CREATE TABLE "trade_proposals" (
	"id" text PRIMARY KEY NOT NULL,
	"candidate_id" text NOT NULL,
	"mode" text NOT NULL,
	"token_address" text NOT NULL,
	"strategy" text NOT NULL,
	"size" numeric(38, 18) NOT NULL,
	"status" text NOT NULL,
	"created_at" bigint NOT NULL,
	"expires_at" bigint NOT NULL,
	"data" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "trades" (
	"id" text PRIMARY KEY NOT NULL,
	"position_id" text NOT NULL,
	"mode" text NOT NULL,
	"chain" text NOT NULL,
	"token_address" text NOT NULL,
	"pool_address" text NOT NULL,
	"symbol" text NOT NULL,
	"strategy" text NOT NULL,
	"candidate_id" text NOT NULL,
	"entry_at" bigint NOT NULL,
	"exit_at" bigint NOT NULL,
	"entry_price" numeric(38, 18) NOT NULL,
	"exit_price" numeric(38, 18) NOT NULL,
	"size" numeric(38, 18) NOT NULL,
	"qty" numeric(38, 18) NOT NULL,
	"gross_pnl" numeric(38, 18) NOT NULL,
	"fees" numeric(38, 18) NOT NULL,
	"net_pnl" numeric(38, 18) NOT NULL,
	"return_pct" numeric(38, 18) NOT NULL,
	"hold_sec" integer NOT NULL,
	"exit_reason" text NOT NULL,
	"tx_status" text NOT NULL,
	"slippage_pct" numeric(38, 18) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "trading_accounts" (
	"mode" text PRIMARY KEY NOT NULL,
	"currency" text NOT NULL,
	"starting_equity" numeric(38, 18) NOT NULL,
	"cash" numeric(38, 18) NOT NULL,
	"reserved" numeric(38, 18) NOT NULL,
	"deposits" numeric(38, 18) NOT NULL,
	"withdrawals" numeric(38, 18) NOT NULL,
	"realized_pnl" numeric(38, 18) NOT NULL,
	"fees_paid" numeric(38, 18) NOT NULL,
	"peak_equity" numeric(38, 18) NOT NULL,
	"day_start_equity" numeric(38, 18) NOT NULL,
	"day_key" text NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "trading_configurations" (
	"version" integer PRIMARY KEY NOT NULL,
	"trading" jsonb NOT NULL,
	"changed_by" text NOT NULL,
	"changed_at" bigint NOT NULL,
	"note" text DEFAULT '' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "transactions" (
	"id" text PRIMARY KEY NOT NULL,
	"order_id" text NOT NULL,
	"mode" text NOT NULL,
	"chain" text NOT NULL,
	"signature" text NOT NULL,
	"status" text NOT NULL,
	"error" text,
	"network_fee_quote" numeric(38, 18),
	"submitted_at" bigint NOT NULL,
	"confirmed_at" bigint,
	"simulated" boolean NOT NULL,
	"explorer_url" text
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" text PRIMARY KEY NOT NULL,
	"username" text NOT NULL,
	"password_hash" text NOT NULL,
	"role" text NOT NULL,
	"created_at" bigint NOT NULL,
	"disabled" boolean DEFAULT false NOT NULL,
	CONSTRAINT "users_username_unique" UNIQUE("username")
);
--> statement-breakpoint
CREATE TABLE "wallets" (
	"id" text PRIMARY KEY NOT NULL,
	"chain" text NOT NULL,
	"address" text NOT NULL,
	"label" text NOT NULL,
	"mode" text NOT NULL,
	"allowed" boolean DEFAULT false NOT NULL,
	"spend_limit_quote" numeric(38, 18),
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
ALTER TABLE "backtest_trades" ADD CONSTRAINT "backtest_trades_run_id_backtest_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."backtest_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "position_events" ADD CONSTRAINT "position_events_position_id_positions_id_fk" FOREIGN KEY ("position_id") REFERENCES "public"."positions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trades" ADD CONSTRAINT "trades_position_id_positions_id_fk" FOREIGN KEY ("position_id") REFERENCES "public"."positions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "alerts_ts" ON "alerts" USING btree ("ts");--> statement-breakpoint
CREATE INDEX "audit_ts" ON "audit_log" USING btree ("ts");--> statement-breakpoint
CREATE INDEX "audit_correlation" ON "audit_log" USING btree ("correlation_id");--> statement-breakpoint
CREATE INDEX "audit_agent" ON "audit_log" USING btree ("agent","seq");--> statement-breakpoint
CREATE INDEX "audit_position" ON "audit_log" USING btree ("position_id");--> statement-breakpoint
CREATE INDEX "audit_search" ON "audit_log" USING gin (to_tsvector('simple', "action" || ' ' || "reason" || ' ' || coalesce("symbol", '')));--> statement-breakpoint
CREATE INDEX "backtest_trades_run" ON "backtest_trades" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "candidates_stage" ON "candidates" USING btree ("stage");--> statement-breakpoint
CREATE INDEX "candidates_token" ON "candidates" USING btree ("chain","token_address");--> statement-breakpoint
CREATE INDEX "candidates_updated" ON "candidates" USING btree ("updated_at");--> statement-breakpoint
CREATE INDEX "equity_mode_ts" ON "equity_snapshots" USING btree ("mode","ts");--> statement-breakpoint
CREATE INDEX "pools_token" ON "liquidity_pools" USING btree ("chain","token_address");--> statement-breakpoint
CREATE INDEX "snapshots_pool_ts" ON "market_snapshots" USING btree ("chain","pool_address","ts");--> statement-breakpoint
CREATE INDEX "snapshots_fetched" ON "market_snapshots" USING btree ("fetched_at");--> statement-breakpoint
CREATE UNIQUE INDEX "orders_idempotency" ON "orders" USING btree ("idempotency_key");--> statement-breakpoint
CREATE INDEX "orders_status" ON "orders" USING btree ("status");--> statement-breakpoint
CREATE INDEX "orders_position" ON "orders" USING btree ("position_id");--> statement-breakpoint
CREATE INDEX "orders_candidate" ON "orders" USING btree ("candidate_id");--> statement-breakpoint
CREATE INDEX "position_events_position" ON "position_events" USING btree ("position_id","ts");--> statement-breakpoint
CREATE INDEX "positions_status" ON "positions" USING btree ("mode","status");--> statement-breakpoint
CREATE INDEX "positions_token" ON "positions" USING btree ("chain","token_address");--> statement-breakpoint
CREATE INDEX "risk_decisions_candidate" ON "risk_decisions" USING btree ("candidate_id");--> statement-breakpoint
CREATE INDEX "assessments_candidate" ON "security_assessments" USING btree ("candidate_id");--> statement-breakpoint
CREATE INDEX "assessments_token" ON "security_assessments" USING btree ("chain","token_address");--> statement-breakpoint
CREATE INDEX "signals_candidate" ON "strategy_signals" USING btree ("candidate_id");--> statement-breakpoint
CREATE INDEX "tokens_symbol" ON "tokens" USING btree ("symbol");--> statement-breakpoint
CREATE INDEX "proposals_candidate" ON "trade_proposals" USING btree ("candidate_id");--> statement-breakpoint
CREATE INDEX "proposals_status" ON "trade_proposals" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "trades_position" ON "trades" USING btree ("position_id");--> statement-breakpoint
CREATE INDEX "trades_mode_exit" ON "trades" USING btree ("mode","exit_at");--> statement-breakpoint
CREATE INDEX "trades_symbol" ON "trades" USING btree ("symbol");--> statement-breakpoint
CREATE UNIQUE INDEX "transactions_signature" ON "transactions" USING btree ("chain","signature");--> statement-breakpoint
CREATE INDEX "transactions_order" ON "transactions" USING btree ("order_id");--> statement-breakpoint
CREATE UNIQUE INDEX "wallets_chain_address" ON "wallets" USING btree ("chain","address");