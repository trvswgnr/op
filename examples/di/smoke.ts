import {
  DuplicateEmailError,
  ClockService,
  DatabaseService,
  MailerService,
  PasswordHasherService,
  createExampleServices,
  registerUser,
  runnableRegisterUser,
} from "./onboarding.ts";

class AssertionError extends Error {
  name = "AssertionError";
}

type Assert = (condition: unknown, message: string) => asserts condition;
const assert: Assert = (condition, message) => {
  if (!condition) throw new AssertionError(message);
};

async function runSuccessfulRegistrationSmoke() {
  const { op, services } = runnableRegisterUser();

  const result = await op.run("marissa@example.test", "correct horse battery staple");

  assert(result.isOk(), "registration should succeed");
  assert(result.value.email === "marissa@example.test", "registered user email should match");
  assert(result.value.createdAt === "2026-05-15T12:00:00.000Z", "createdAt should come from clock");
  assert(services.db.records.length === 1, "database should contain the registered user");
  assert(
    services.sentWelcomeEmails.join(",") === "marissa@example.test",
    "mailer should send one welcome email",
  );
}

async function runDuplicateRegistrationSmoke() {
  const services = createExampleServices();
  const op = registerUser
    .provide(DatabaseService, services.db)
    .provide(PasswordHasherService, services.hasher)
    .provide(MailerService, services.mailer)
    .provide(ClockService, services.clock);

  const first = await op.run("existing@example.test", "first");
  assert(first.isOk(), "first registration should succeed");

  const duplicate = await op.run("existing@example.test", "second");
  assert(
    duplicate.isErr() && duplicate.error instanceof DuplicateEmailError,
    "duplicate registration should fail with DuplicateEmailError",
  );
  assert(services.db.records.length === 1, "duplicate registration should not insert a user");
  assert(
    services.sentWelcomeEmails.join(",") === "existing@example.test",
    "duplicate registration should not send another welcome email",
  );
}

await runSuccessfulRegistrationSmoke();
await runDuplicateRegistrationSmoke();
