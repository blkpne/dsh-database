import type { Connection } from './model.js';

const guideKey = 'dsh-database:first-connection-guide:v1';
const pageGuide = { offered: false };
type GuideStorage = {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
};

/** One non-sensitive browser preference; no connection identifiers or credentials. */
export class FirstConnectionHint {
  private offered = false;
  constructor(
    private readonly storage: () => GuideStorage = () => localStorage,
    private readonly page = pageGuide,
  ) {}

  observeExisting(count: number) {
    if (count > 0) this.remember();
  }

  claim(): boolean {
    if (this.offered || this.page.offered) return false;
    try {
      if (this.storage().getItem(guideKey) === '1') return false;
    } catch {
      // A blocked browser store must never prevent configuring a database.
    }
    this.remember();
    return true;
  }

  private remember() {
    this.offered = true;
    this.page.offered = true;
    try {
      this.storage().setItem(guideKey, '1');
    } catch {
      // Keep the in-page fallback when storage is unavailable.
    }
  }
}

/** Only saved, unambiguous, active connections can be suggested to a conversation. */
export function firstQuestionBlock(
  connection: Connection,
  connections: readonly Connection[],
  dirty: boolean,
): string | undefined {
  if (dirty) return '请先保存或取消修改，再使用已保存连接的示例问题。';
  if (connection.status === 'error') return '请先处理上方的连接错误，再开启 Agent 访问。';
  if (!connection.enabled || connection.status !== 'enabled')
    return '连接已保存。请先开启上方的 Agent 访问，再复制首问。';
  if (
    connections.some(
      (other) =>
        other.id !== connection.id &&
        other.name.trim().toLocaleLowerCase() === connection.name.trim().toLocaleLowerCase(),
    )
  )
    return '存在同名连接。请修改连接名称并保存，以免对话选错数据库。';
  return undefined;
}

export function firstQuestion(connection: Connection): string {
  return `使用「${connection.name}」查看有哪些${connection.engine === 'mongodb' ? '集合' : '表'}，先只查看结构，不读取业务行。如果找不到这条连接，请告诉我，不要改用其他连接。`;
}

/** Clipboard writes cannot be aborted; late completions must not update a new view. */
export class QuestionCopy {
  private active?: object;

  cancel() {
    this.active = undefined;
  }

  async run(
    text: string,
    write: (text: string) => Promise<void>,
    isCurrent: () => boolean,
    completed: () => void,
    failed: () => void,
  ): Promise<void> {
    if (this.active) return;
    const own = (this.active = {});
    try {
      await write(text);
      if (this.active === own && isCurrent()) completed();
    } catch {
      if (this.active === own && isCurrent()) failed();
    } finally {
      if (this.active === own) this.active = undefined;
    }
  }
}
