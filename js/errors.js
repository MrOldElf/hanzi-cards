/** Ошибка, текст которой можно показать пользователю как есть. */
export class ImportError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ImportError';
  }
}
