import {
  pgTable,
  serial,
  text,
  integer,
  timestamp,
  boolean,
  uniqueIndex,
  index
} from 'drizzle-orm/pg-core';

import { relations } from 'drizzle-orm';

/* ============================================================
   1️⃣ USERS (Synced from Clerk)
============================================================ */

export const users = pgTable('users', {
  id: serial('id').primaryKey(),
  clerkId: text('clerk_id').unique().notNull(),
  email: text('email').notNull(),
  fullName: text('full_name'),
  avatarUrl: text('avatar_url'),
  githubId: text('github_id').unique(),
  tier: text('tier').default('free'),
  credits: integer('credits').default(10),
  createdAt: timestamp('created_at').defaultNow(),
  updatedAt: timestamp('updated_at').defaultNow(),
});

/* ============================================================
   2️⃣ INSTALLATIONS (Linked to Users)
============================================================ */

export const installations = pgTable('installations', {
  id: serial('id').primaryKey(),
  userId: integer('user_id')
    .references(() => users.id, { onDelete: 'cascade' })
    .notNull(),
  githubInstallationId: integer('github_installation_id').unique().notNull(),
  accountLogin: text('account_login').notNull(),
  accountType: text('account_type').notNull(),
  createdAt: timestamp('created_at').defaultNow(),
});

/* ============================================================
   3️⃣ REPOSITORIES (Linked to Installations)
============================================================ */

export const repositories = pgTable(
  'repositories',
  {
    id: serial('id').primaryKey(),

    installationId: integer('installation_id')
      .references(() => installations.id, { onDelete: 'cascade' })
      .notNull(),

    githubRepoId: integer('github_repo_id').notNull(),

    name: text('name').notNull(),
    fullName: text('full_name').notNull(),
    private: boolean('private').default(false),
    url: text('url').notNull(),
    isIndexed: boolean('is_indexed').default(false),

    createdAt: timestamp('created_at').defaultNow(),
  },
  (table) => ({
    // Prevent duplicate repo per installation
    uniqueRepo: uniqueIndex('unique_repo_per_installation').on(
      table.installationId,
      table.githubRepoId
    ),
  })
);

/* ============================================================
   4️⃣ SYMBOLS (Graph Nodes — Base Graph)
============================================================ */

export const symbols = pgTable(
  'symbols',
  {
    id: serial('id').primaryKey(),

    repositoryId: integer('repository_id')
      .references(() => repositories.id, { onDelete: 'cascade' })
      .notNull(),

    filePath: text('file_path').notNull(),
    symbolName: text('symbol_name').notNull(),
    symbolType: text('symbol_type').notNull(), // function | class | method
    startLine: integer('start_line').notNull(),
    endLine: integer('end_line').notNull(),
    sourceCode: text('source_code'), // Monolithic code storage — avoids Pinecone round-trips

    createdAt: timestamp('created_at').defaultNow(),
  },
  (table) => ({
    // Deterministic unique constraint — no startLine dependency
    uniqueSymbol: uniqueIndex('unique_symbol').on(
      table.repositoryId,
      table.filePath,
      table.symbolName
    ),

    // Performance index for repo-based queries
    repoIndex: index('idx_symbols_repo').on(table.repositoryId),
  })
);

/* ============================================================
   5️⃣ EDGES (Graph Dependencies — Base Graph)
============================================================ */

export const edges = pgTable(
  'edges',
  {
    id: serial('id').primaryKey(),

    repositoryId: integer('repository_id')
      .references(() => repositories.id, { onDelete: 'cascade' })
      .notNull(),

    fromSymbolId: integer('from_symbol_id')
      .references(() => symbols.id, { onDelete: 'cascade' })
      .notNull(),

    toSymbolId: integer('to_symbol_id')
      .references(() => symbols.id, { onDelete: 'cascade' })
      .notNull(),

    edgeType: text('edge_type').notNull(), // calls | imports

    createdAt: timestamp('created_at').defaultNow(),
  },
  (table) => ({
    // Prevent duplicate edges
    uniqueEdge: uniqueIndex('unique_edge').on(
      table.repositoryId,
      table.fromSymbolId,
      table.toSymbolId,
      table.edgeType
    ),

    // Performance indexes for graph traversal
    repoIndex: index('idx_edges_repo').on(table.repositoryId),
    toIndex: index('idx_edges_to_symbol').on(table.toSymbolId),
    fromIndex: index('idx_edges_from_symbol').on(table.fromSymbolId),
  })
);

/* ============================================================
   6️⃣ PR_SYMBOLS (Delta Graph — Isolated PR State)
============================================================ */

export const prSymbols = pgTable(
  'pr_symbols',
  {
    id: serial('id').primaryKey(),

    pullRequestId: integer('pull_request_id').notNull(),

    repositoryId: integer('repository_id')
      .references(() => repositories.id, { onDelete: 'cascade' })
      .notNull(),

    filePath: text('file_path').notNull(),
    symbolName: text('symbol_name').notNull(),
    symbolType: text('symbol_type').notNull(),
    startLine: integer('start_line').notNull(),
    endLine: integer('end_line').notNull(),
    sourceCode: text('source_code'),

    createdAt: timestamp('created_at').defaultNow(),
  },
  (table) => ({
    // Unique per PR — prevents duplicates within the same PR
    uniquePrSymbol: uniqueIndex('unique_pr_symbol').on(
      table.pullRequestId,
      table.filePath,
      table.symbolName
    ),

    // Performance indexes
    prIndex: index('idx_pr_symbols_pr').on(table.pullRequestId),
    repoIndex: index('idx_pr_symbols_repo').on(table.repositoryId),
  })
);

/* ============================================================
   7️⃣ PR_EDGES (Delta Graph — Isolated PR Dependencies)
============================================================ */

export const prEdges = pgTable(
  'pr_edges',
  {
    id: serial('id').primaryKey(),

    pullRequestId: integer('pull_request_id').notNull(),

    repositoryId: integer('repository_id')
      .references(() => repositories.id, { onDelete: 'cascade' })
      .notNull(),

    fromSymbolId: integer('from_symbol_id')
      .references(() => prSymbols.id, { onDelete: 'cascade' })
      .notNull(),

    toSymbolId: integer('to_symbol_id')
      .references(() => prSymbols.id, { onDelete: 'cascade' })
      .notNull(),

    edgeType: text('edge_type').notNull(),

    createdAt: timestamp('created_at').defaultNow(),
  },
  (table) => ({
    // Prevent duplicate PR edges
    uniquePrEdge: uniqueIndex('unique_pr_edge').on(
      table.pullRequestId,
      table.fromSymbolId,
      table.toSymbolId,
      table.edgeType
    ),

    // Performance indexes
    prIndex: index('idx_pr_edges_pr').on(table.pullRequestId),
    repoIndex: index('idx_pr_edges_repo').on(table.repositoryId),
    toIndex: index('idx_pr_edges_to_symbol').on(table.toSymbolId),
    fromIndex: index('idx_pr_edges_from_symbol').on(table.fromSymbolId),
  })
);

/* ============================================================
   RELATIONSHIPS
============================================================ */

export const usersRelations = relations(users, ({ many }) => ({
  installations: many(installations),
}));

export const installationsRelations = relations(
  installations,
  ({ one, many }) => ({
    user: one(users, {
      fields: [installations.userId],
      references: [users.id],
    }),
    repositories: many(repositories),
  })
);

export const repositoriesRelations = relations(
  repositories,
  ({ one, many }) => ({
    installation: one(installations, {
      fields: [repositories.installationId],
      references: [installations.id],
    }),
    symbols: many(symbols),
    edges: many(edges),
    prSymbols: many(prSymbols),
    prEdges: many(prEdges),
  })
);

export const symbolsRelations = relations(symbols, ({ one, many }) => ({
  repository: one(repositories, {
    fields: [symbols.repositoryId],
    references: [repositories.id],
  }),
  outgoingEdges: many(edges),
}));

export const edgesRelations = relations(edges, ({ one }) => ({
  repository: one(repositories, {
    fields: [edges.repositoryId],
    references: [repositories.id],
  }),
  fromSymbol: one(symbols, {
    fields: [edges.fromSymbolId],
    references: [symbols.id],
  }),
  toSymbol: one(symbols, {
    fields: [edges.toSymbolId],
    references: [symbols.id],
  }),
}));

export const prSymbolsRelations = relations(prSymbols, ({ one, many }) => ({
  repository: one(repositories, {
    fields: [prSymbols.repositoryId],
    references: [repositories.id],
  }),
  outgoingEdges: many(prEdges),
}));

export const prEdgesRelations = relations(prEdges, ({ one }) => ({
  repository: one(repositories, {
    fields: [prEdges.repositoryId],
    references: [repositories.id],
  }),
  fromSymbol: one(prSymbols, {
    fields: [prEdges.fromSymbolId],
    references: [prSymbols.id],
  }),
  toSymbol: one(prSymbols, {
    fields: [prEdges.toSymbolId],
    references: [prSymbols.id],
  }),
}));
