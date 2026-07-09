CREATE TABLE "edges" (
	"id" serial PRIMARY KEY NOT NULL,
	"repository_id" integer NOT NULL,
	"from_symbol_id" integer NOT NULL,
	"to_symbol_id" integer NOT NULL,
	"edge_type" text NOT NULL,
	"created_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "installations" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"github_installation_id" integer NOT NULL,
	"account_login" text NOT NULL,
	"account_type" text NOT NULL,
	"created_at" timestamp DEFAULT now(),
	CONSTRAINT "installations_github_installation_id_unique" UNIQUE("github_installation_id")
);
--> statement-breakpoint
CREATE TABLE "pr_edges" (
	"id" serial PRIMARY KEY NOT NULL,
	"pull_request_id" integer NOT NULL,
	"repository_id" integer NOT NULL,
	"from_symbol_id" integer NOT NULL,
	"to_symbol_id" integer NOT NULL,
	"edge_type" text NOT NULL,
	"created_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "pr_symbols" (
	"id" serial PRIMARY KEY NOT NULL,
	"pull_request_id" integer NOT NULL,
	"repository_id" integer NOT NULL,
	"file_path" text NOT NULL,
	"symbol_name" text NOT NULL,
	"symbol_type" text NOT NULL,
	"start_line" integer NOT NULL,
	"end_line" integer NOT NULL,
	"source_code" text,
	"created_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "repositories" (
	"id" serial PRIMARY KEY NOT NULL,
	"installation_id" integer NOT NULL,
	"github_repo_id" integer NOT NULL,
	"name" text NOT NULL,
	"full_name" text NOT NULL,
	"private" boolean DEFAULT false,
	"url" text NOT NULL,
	"is_indexed" boolean DEFAULT false,
	"created_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "symbols" (
	"id" serial PRIMARY KEY NOT NULL,
	"repository_id" integer NOT NULL,
	"file_path" text NOT NULL,
	"symbol_name" text NOT NULL,
	"symbol_type" text NOT NULL,
	"start_line" integer NOT NULL,
	"end_line" integer NOT NULL,
	"source_code" text,
	"created_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" serial PRIMARY KEY NOT NULL,
	"clerk_id" text NOT NULL,
	"email" text NOT NULL,
	"full_name" text,
	"avatar_url" text,
	"github_id" text,
	"tier" text DEFAULT 'free',
	"credits" integer DEFAULT 10,
	"created_at" timestamp DEFAULT now(),
	"updated_at" timestamp DEFAULT now(),
	CONSTRAINT "users_clerk_id_unique" UNIQUE("clerk_id"),
	CONSTRAINT "users_github_id_unique" UNIQUE("github_id")
);
--> statement-breakpoint
ALTER TABLE "edges" ADD CONSTRAINT "edges_repository_id_repositories_id_fk" FOREIGN KEY ("repository_id") REFERENCES "public"."repositories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "edges" ADD CONSTRAINT "edges_from_symbol_id_symbols_id_fk" FOREIGN KEY ("from_symbol_id") REFERENCES "public"."symbols"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "edges" ADD CONSTRAINT "edges_to_symbol_id_symbols_id_fk" FOREIGN KEY ("to_symbol_id") REFERENCES "public"."symbols"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "installations" ADD CONSTRAINT "installations_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pr_edges" ADD CONSTRAINT "pr_edges_repository_id_repositories_id_fk" FOREIGN KEY ("repository_id") REFERENCES "public"."repositories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pr_edges" ADD CONSTRAINT "pr_edges_from_symbol_id_pr_symbols_id_fk" FOREIGN KEY ("from_symbol_id") REFERENCES "public"."pr_symbols"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pr_edges" ADD CONSTRAINT "pr_edges_to_symbol_id_pr_symbols_id_fk" FOREIGN KEY ("to_symbol_id") REFERENCES "public"."pr_symbols"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pr_symbols" ADD CONSTRAINT "pr_symbols_repository_id_repositories_id_fk" FOREIGN KEY ("repository_id") REFERENCES "public"."repositories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "repositories" ADD CONSTRAINT "repositories_installation_id_installations_id_fk" FOREIGN KEY ("installation_id") REFERENCES "public"."installations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "symbols" ADD CONSTRAINT "symbols_repository_id_repositories_id_fk" FOREIGN KEY ("repository_id") REFERENCES "public"."repositories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "unique_edge" ON "edges" USING btree ("repository_id","from_symbol_id","to_symbol_id","edge_type");--> statement-breakpoint
CREATE INDEX "idx_edges_repo" ON "edges" USING btree ("repository_id");--> statement-breakpoint
CREATE INDEX "idx_edges_to_symbol" ON "edges" USING btree ("to_symbol_id");--> statement-breakpoint
CREATE INDEX "idx_edges_from_symbol" ON "edges" USING btree ("from_symbol_id");--> statement-breakpoint
CREATE UNIQUE INDEX "unique_pr_edge" ON "pr_edges" USING btree ("pull_request_id","from_symbol_id","to_symbol_id","edge_type");--> statement-breakpoint
CREATE INDEX "idx_pr_edges_pr" ON "pr_edges" USING btree ("pull_request_id");--> statement-breakpoint
CREATE INDEX "idx_pr_edges_repo" ON "pr_edges" USING btree ("repository_id");--> statement-breakpoint
CREATE INDEX "idx_pr_edges_to_symbol" ON "pr_edges" USING btree ("to_symbol_id");--> statement-breakpoint
CREATE INDEX "idx_pr_edges_from_symbol" ON "pr_edges" USING btree ("from_symbol_id");--> statement-breakpoint
CREATE UNIQUE INDEX "unique_pr_symbol" ON "pr_symbols" USING btree ("pull_request_id","file_path","symbol_name");--> statement-breakpoint
CREATE INDEX "idx_pr_symbols_pr" ON "pr_symbols" USING btree ("pull_request_id");--> statement-breakpoint
CREATE INDEX "idx_pr_symbols_repo" ON "pr_symbols" USING btree ("repository_id");--> statement-breakpoint
CREATE UNIQUE INDEX "unique_repo_per_installation" ON "repositories" USING btree ("installation_id","github_repo_id");--> statement-breakpoint
CREATE UNIQUE INDEX "unique_symbol" ON "symbols" USING btree ("repository_id","file_path","symbol_name");--> statement-breakpoint
CREATE INDEX "idx_symbols_repo" ON "symbols" USING btree ("repository_id");