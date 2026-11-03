/** Admin API: user administration, invitations and the audit log. */

import { all, batch, changed, one, stmt } from './db';
import { digest, now, token } from './crypto';
import { fail, json, pageParams, readBody, rfc3339 } from './http';
import type { Identity, RouteContext } from './types';

interface UserRow {
  id: string;
  username: string;
  role: string;
  disabled: number;
  created: string;
}

interface AuditRow {
  seq: number;
  actor: string;
  action: string;
  target: string;
  created: string;
}

interface InvitationRow {
  hash: string;
  expires: number;
}

function userJson(row: UserRow): Record<string, unknown> {
  return {
    accountId: row.id,
    username: row.username,
    role: row.role,
    disabled: row.disabled !== 0,
    createdAt: row.created,
  };
}

async function safeUser(ctx: RouteContext, accountId: string): Promise<Record<string, unknown>> {
  const row = await one<UserRow>(
    ctx.env.DB,
    'SELECT id, username, role, disabled, created FROM accounts WHERE id = ?',
    accountId,
  );
  if (row === null) throw fail(404, 'account_not_found');
  return userJson(row);
}

async function listUsers(ctx: RouteContext): Promise<Response> {
  const rows = await all<UserRow>(
    ctx.env.DB,
    'SELECT id, username, role, disabled, created FROM accounts ORDER BY created, id',
  );
  return json(rows.map(userJson));
}

async function updateUser(
  ctx: RouteContext,
  identity: Identity,
  accountId: string,
): Promise<Response> {
  const body = await readBody(ctx.request, { disabled: 'boolean?' });
  if (body.disabled === undefined) throw fail(400, 'disabled_required');
  const disabled = body.disabled;

  if (disabled && accountId === identity.account) throw fail(409, 'cannot_disable_self');

  const target = await one<{ role: string }>(
    ctx.env.DB,
    'SELECT role FROM accounts WHERE id = ?',
    accountId,
  );
  if (target === null) throw fail(404, 'account_not_found');

  // The disable is guarded in SQLite itself: the last enabled admin cannot be
  // disabled even if two concurrent requests each pass an earlier count check.
  const statements = [
    disabled
      ? stmt(
          ctx.env.DB,
          `UPDATE accounts SET disabled = 1
             WHERE id = ?
               AND (role != 'admin'
                    OR (SELECT COUNT(*) FROM accounts WHERE role = 'admin' AND disabled = 0 AND id != ?) > 0)`,
          accountId,
          accountId,
        )
      : stmt(ctx.env.DB, 'UPDATE accounts SET disabled = 0 WHERE id = ?', accountId),
  ];
  if (disabled) {
    statements.push(
      stmt(
        ctx.env.DB,
        `UPDATE families SET revoked = 1
           WHERE account = ? AND EXISTS (SELECT 1 FROM accounts WHERE id = ? AND disabled = 1)`,
        accountId,
        accountId,
      ),
    );
  }
  statements.push(
    stmt(
      ctx.env.DB,
      `INSERT INTO audit (actor, action, target, created)
         SELECT ?, ?, ?, ?
          WHERE EXISTS (SELECT 1 FROM accounts WHERE id = ? AND disabled = ?)`,
      identity.account,
      'account.disabled.change',
      accountId,
      now(),
      accountId,
      disabled ? 1 : 0,
    ),
  );
  const results = await batch(ctx.env.DB, statements);
  if (disabled && changed(results[0]) !== 1) throw fail(409, 'last_admin');

  return json(await safeUser(ctx, accountId));
}

async function createInvitation(ctx: RouteContext, identity: Identity): Promise<Response> {
  const value = token();
  const hash = await digest(value);
  const expires = Math.floor(Date.now() / 1000) + 24 * 60 * 60;

  await batch(ctx.env.DB, [
    stmt(ctx.env.DB, 'INSERT INTO invitations (hash, expires) VALUES (?, ?)', hash, expires),
    stmt(
      ctx.env.DB,
      'INSERT INTO audit (actor, action, target, created) VALUES (?, ?, ?, ?)',
      identity.account,
      'invitation.create',
      '',
      now(),
    ),
  ]);

  return json({ token: value, expiresAt: rfc3339(new Date(expires * 1000)) }, 201);
}

async function listAudit(ctx: RouteContext): Promise<Response> {
  const { cursor, limit } = pageParams(ctx.url);
  const rows = await all<AuditRow>(
    ctx.env.DB,
    'SELECT seq, actor, action, target, created FROM audit WHERE seq > ? ORDER BY seq LIMIT ?',
    cursor,
    limit + 1,
  );
  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  let nextCursor = cursor;
  const last = page[page.length - 1];
  if (last !== undefined) nextCursor = last.seq;
  return json({
    events: page.map((row) => ({
      seq: row.seq,
      actorId: row.actor,
      action: row.action,
      targetId: row.target,
      createdAt: row.created,
    })),
    cursor: nextCursor,
    hasMore,
  });
}

/** Admin route dispatcher; returns null when the path is not an admin route. */
export async function adminRoutes(
  ctx: RouteContext,
  identity: Identity,
): Promise<Response | null> {
  const { path, method } = ctx;
  if (!path.startsWith('/admin/')) return null;
  if (identity.role !== 'admin') throw fail(403, 'forbidden');

  if (path === '/admin/users' && method === 'GET') return listUsers(ctx);
  if (path === '/admin/invitations' && method === 'POST') {
    return createInvitation(ctx, identity);
  }
  if (path === '/admin/audit' && method === 'GET') return listAudit(ctx);

  const userMatch = /^\/admin\/users\/([^/]+)$/.exec(path);
  if (userMatch !== null && method === 'PATCH') {
    let accountId: string;
    try {
      accountId = decodeURIComponent(userMatch[1] ?? '');
    } catch {
      // A malformed percent escape is not a valid account id (Go's HTTP layer
      // rejected such request URIs before routing).
      throw fail(404, 'not_found');
    }
    return updateUser(ctx, identity, accountId);
  }

  throw fail(404, 'not_found');
}

export interface AdminInvitationRow extends InvitationRow {}
