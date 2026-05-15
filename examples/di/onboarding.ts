import { Context, withContext } from "@prodkit/di";
import { Op } from "@prodkit/op";
import { TaggedError } from "better-result";

export class DuplicateEmailError extends TaggedError("DuplicateEmailError")<{
  email: string;
}>() {}

export class DatabaseError extends TaggedError("DatabaseError")<{
  cause: unknown;
}>() {}

export class EmailDeliveryError extends TaggedError("EmailDeliveryError")<{
  email: string;
  cause: unknown;
}>() {}

export interface User {
  readonly id: string;
  readonly email: string;
  readonly createdAt: string;
}

export interface Database {
  findUserByEmail: Op<User | undefined, DatabaseError, [email: string]>;
  insertUser: Op<User, DatabaseError | DuplicateEmailError, [input: NewUserRecord]>;
}

export interface NewUserRecord {
  readonly email: string;
  readonly passwordHash: string;
  readonly createdAt: string;
}

export interface PasswordHasher {
  hash: Op<string, never, [password: string]>;
}

export interface Mailer {
  sendWelcome: Op<void, EmailDeliveryError, [user: User]>;
}

export interface Clock {
  nowIso: Op<string, never, []>;
}

export class DatabaseService extends Context("DatabaseService")<Database> {}
export class PasswordHasherService extends Context("PasswordHasherService")<PasswordHasher> {}
export class MailerService extends Context("MailerService")<Mailer> {}
export class ClockService extends Context("ClockService")<Clock> {}

export const loadExistingUser = withContext(function* (email: string) {
  const db = yield* Context.require(DatabaseService);
  return yield* db.findUserByEmail(email);
});

export const registerUser = withContext(function* (email: string, password: string) {
  const existing = yield* loadExistingUser(email);
  if (existing !== undefined) {
    return yield* new DuplicateEmailError({ email });
  }

  const db = yield* Context.require(DatabaseService);
  const hasher = yield* Context.require(PasswordHasherService);
  const mailer = yield* Context.require(MailerService);
  const clock = yield* Context.require(ClockService);

  const passwordHash = yield* hasher.hash(password);
  const createdAt = yield* clock.nowIso;
  const user = yield* db.insertUser({ email, passwordHash, createdAt });

  yield* mailer.sendWelcome(user);

  return user;
});

export function createInMemoryDatabase(seed: readonly User[] = []): Database & {
  readonly records: readonly User[];
} {
  const records = new Map(seed.map((user) => [user.email, user]));

  return {
    get records() {
      return [...records.values()];
    },
    findUserByEmail: Op(function* (email: string) {
      return records.get(email);
    }).mapErr((error): DatabaseError => error),
    insertUser: Op(function* (input: NewUserRecord) {
      if (records.has(input.email)) {
        return yield* new DuplicateEmailError({ email: input.email });
      }

      const user: User = {
        id: `usr_${records.size + 1}`,
        email: input.email,
        createdAt: input.createdAt,
      };
      records.set(input.email, user);
      return user;
    }).mapErr((error): DatabaseError | DuplicateEmailError => error),
  };
}

export function createExampleServices() {
  const db = createInMemoryDatabase();
  const sentWelcomeEmails: string[] = [];

  return {
    db,
    sentWelcomeEmails,
    hasher: {
      hash: Op(function* (password: string) {
        return `hash:${password}`;
      }),
    } satisfies PasswordHasher,
    mailer: {
      sendWelcome: Op(function* (user: User) {
        sentWelcomeEmails.push(user.email);
      }).mapErr(
        (error): EmailDeliveryError =>
          new EmailDeliveryError({
            email: "unknown",
            cause: error,
          }),
      ),
    } satisfies Mailer,
    clock: {
      nowIso: Op.of("2026-05-15T12:00:00.000Z"),
    } satisfies Clock,
  };
}

export function runnableRegisterUser() {
  const services = createExampleServices();
  const op = registerUser
    .provide(DatabaseService, services.db)
    .provide(PasswordHasherService, services.hasher)
    .provide(MailerService, services.mailer)
    .provide(ClockService, services.clock);

  return { op, services };
}
