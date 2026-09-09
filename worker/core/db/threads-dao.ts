import type { DbChatMessage, DbChatThread } from "./schema";

export class ThreadsDao {
	constructor(private db: D1Database) {}

	async list(ownerId: string): Promise<{ threads: DbChatThread[] }> {
		const { results } = await this.db
			.prepare(
				"SELECT * FROM chat_threads WHERE owner_id = ? ORDER BY updated_at DESC LIMIT 100",
			)
			.bind(ownerId)
			.all<DbChatThread>();
		return { threads: results };
	}

	async get(id: string, ownerId: string): Promise<DbChatThread | null> {
		return (
			(await this.db
				.prepare("SELECT * FROM chat_threads WHERE id = ? AND owner_id = ?")
				.bind(id, ownerId)
				.first<DbChatThread>()) ?? null
		);
	}

	async create(thread: DbChatThread): Promise<void> {
		await this.db
			.prepare(
				"INSERT INTO chat_threads (id, owner_id, title, model_id, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
			)
			.bind(
				thread.id,
				thread.owner_id,
				thread.title,
				thread.model_id,
				thread.status,
				thread.created_at,
				thread.updated_at,
			)
			.run();
	}

	async updateTitle(id: string, ownerId: string, title: string): Promise<void> {
		await this.db
			.prepare(
				"UPDATE chat_threads SET title = ?, updated_at = ? WHERE id = ? AND owner_id = ?",
			)
			.bind(title, Date.now(), id, ownerId)
			.run();
	}

	async updateModel(
		threadId: string,
		ownerId: string,
		model_id: string,
	): Promise<void> {
		await this.db
			.prepare(
				"UPDATE chat_threads SET model_id = ?, updated_at = ? WHERE id = ? AND owner_id = ?",
			)
			.bind(model_id, Date.now(), threadId, ownerId)
			.run();
	}

	async updateStatus(
		id: string,
		ownerId: string,
		status: "regular" | "archived",
	): Promise<void> {
		await this.db
			.prepare(
				"UPDATE chat_threads SET status = ?, updated_at = ? WHERE id = ? AND owner_id = ?",
			)
			.bind(status, Date.now(), id, ownerId)
			.run();
	}

	async delete(id: string, ownerId: string): Promise<void> {
		await this.db.batch([
			// Scope the message deletion to the owning thread. The old query deleted
			// messages first and only checked the owner on the thread row, which let
			// any authenticated user who knew a thread id erase its messages.
			this.db
				.prepare(
					`DELETE FROM chat_messages
					 WHERE thread_id = ?
					   AND EXISTS (
						 SELECT 1 FROM chat_threads
						 WHERE chat_threads.id = ? AND chat_threads.owner_id = ?
					   )`,
				)
				.bind(id, id, ownerId),
			this.db
				.prepare("DELETE FROM chat_threads WHERE id = ? AND owner_id = ?")
				.bind(id, ownerId),
		]);
	}

	async getMessages(
		threadId: string,
		ownerId: string,
	): Promise<DbChatMessage[]> {
		const { results } = await this.db
			.prepare(
				`SELECT m.* FROM chat_messages m
				 JOIN chat_threads t ON t.id = m.thread_id
				 WHERE m.thread_id = ? AND t.owner_id = ?
				 ORDER BY m.created_at ASC`,
			)
			.bind(threadId, ownerId)
			.all<DbChatMessage>();
		return results;
	}

	async addMessage(message: DbChatMessage, ownerId: string): Promise<boolean> {
		const results = await this.db.batch([
			this.db
				.prepare(
					`INSERT INTO chat_messages
					 (id, thread_id, role, content, model_id, created_at)
					 SELECT ?, ?, ?, ?, ?, ?
					 WHERE EXISTS (
						 SELECT 1 FROM chat_threads
						 WHERE chat_threads.id = ? AND chat_threads.owner_id = ?
					 )`,
				)
				.bind(
					message.id,
					message.thread_id,
					message.role,
					message.content,
					message.model_id,
					message.created_at,
					message.thread_id,
					ownerId,
				),
			this.db
				.prepare(
					"UPDATE chat_threads SET updated_at = ? WHERE id = ? AND owner_id = ?",
				)
				.bind(Date.now(), message.thread_id, ownerId),
		]);
		return (results[0]?.meta?.changes ?? 0) > 0;
	}
}
