// [2026-07-20新設] lib/config/env.ts の単体テスト。
import { getServerEnv, __resetServerEnvCacheForTests, MissingEnvError } from '../../lib/config/env';

function assert(cond: unknown, msg: string) {
  if (!cond) throw new Error('FAIL: ' + msg);
  console.log('OK: ' + msg);
}

const savedEnv = { ...process.env };
function resetEnv() {
  for (const k of Object.keys(process.env)) delete process.env[k];
  Object.assign(process.env, savedEnv);
  __resetServerEnvCacheForTests();
}

// ---- ANTHROPIC_API_KEY未設定なら例外(MissingEnvError) ----
resetEnv();
delete process.env.ANTHROPIC_API_KEY;
delete process.env.SUPABASE_SERVICE_ROLE_KEY;
process.env.SUPABASE_SERVICE_ROLE_KEY = 'dummy-service-role-key';
let threw = false;
try {
  getServerEnv();
} catch (e) {
  threw = e instanceof MissingEnvError;
}
assert(threw, 'ANTHROPIC_API_KEY未設定なら getServerEnv() が MissingEnvError を投げる');

// ---- SUPABASE_SERVICE_ROLE_KEY未設定でも同様に例外 ----
resetEnv();
process.env.ANTHROPIC_API_KEY = 'sk-ant-dummy';
delete process.env.SUPABASE_SERVICE_ROLE_KEY;
threw = false;
try {
  getServerEnv();
} catch (e) {
  threw = e instanceof MissingEnvError;
}
assert(threw, 'SUPABASE_SERVICE_ROLE_KEY未設定なら getServerEnv() が MissingEnvError を投げる');

// ---- 必須値が揃っていれば正常に返る。OPENAI_API_KEY等は未設定でも例外にならない ----
resetEnv();
process.env.ANTHROPIC_API_KEY = 'sk-ant-dummy';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'dummy-service-role-key';
delete process.env.OPENAI_API_KEY;
delete process.env.ALLOWED_ORIGINS;
const env = getServerEnv();
assert(env.ANTHROPIC_API_KEY === 'sk-ant-dummy', 'ANTHROPIC_API_KEYが正しく読める');
assert(env.OPENAI_API_KEY === null, '【重要】OPENAI_API_KEY未設定でも例外にならず、nullとして扱われる(現時点でOpenAIは未使用のため必須にしていない)');
assert(Array.isArray(env.ALLOWED_ORIGINS) && env.ALLOWED_ORIGINS.length === 0, 'ALLOWED_ORIGINS未設定時は空配列');
assert(env.RATE_LIMIT_MAX_PER_WINDOW === 5, 'RATE_LIMIT_MAX_PER_WINDOWの既定値は5');
assert(env.RATE_LIMIT_MAX_PER_USER_PER_DAY === 200, 'RATE_LIMIT_MAX_PER_USER_PER_DAYの既定値は200');
assert(env.RATE_LIMIT_MAX_GLOBAL_PER_DAY === 5000, 'RATE_LIMIT_MAX_GLOBAL_PER_DAYの既定値は5000');

// ---- ALLOWED_ORIGINSはカンマ区切りをtrimして配列化される ----
resetEnv();
process.env.ANTHROPIC_API_KEY = 'sk-ant-dummy';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'dummy-service-role-key';
process.env.ALLOWED_ORIGINS = ' https://a.example.com ,https://b.example.com,, ';
const env2 = getServerEnv();
assert(
  JSON.stringify(env2.ALLOWED_ORIGINS) === JSON.stringify(['https://a.example.com', 'https://b.example.com']),
  'ALLOWED_ORIGINSがカンマ区切り・空白除去・空要素除去で配列化される (got: ' + JSON.stringify(env2.ALLOWED_ORIGINS) + ')'
);

resetEnv();
console.log('ALL PASS: env.test.ts');
