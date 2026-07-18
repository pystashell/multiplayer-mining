import assert from "node:assert/strict";
import test from "node:test";
import {
  localeFromLanguage,
  parseLocale,
  translate,
  translateServerMessage,
} from "../app/i18n.ts";

test("selects Chinese only for Chinese browser languages", () => {
  assert.equal(localeFromLanguage("zh-CN,zh;q=0.9,en;q=0.8"), "zh-CN");
  assert.equal(localeFromLanguage("zh-HK"), "zh-CN");
  assert.equal(localeFromLanguage("en-US,en;q=0.9"), "en");
  assert.equal(localeFromLanguage("fr-FR,fr;q=0.9"), "en");
  assert.equal(localeFromLanguage(null), "en");
});

test("accepts only supported saved locale values", () => {
  assert.equal(parseLocale("zh-CN"), "zh-CN");
  assert.equal(parseLocale("en"), "en");
  assert.equal(parseLocale("ja"), null);
  assert.equal(parseLocale(null), null);
});

test("translates interface and server errors without leaking Chinese into English", () => {
  assert.equal(translate("en", "创建房间"), "Create room");
  assert.equal(
    translateServerMessage("en", "ROOM_FULL", "这个房间已经有四个人了。"),
    "This room already has four players.",
  );
  assert.equal(
    translateServerMessage("en", "RATE_LIMITED", "发得太快了，请 7 秒后再试。"),
    "You're sending messages too quickly. Try again in 7 seconds.",
  );
  assert.equal(
    translateServerMessage("en", "BAD_REQUEST", "这个表情包不存在。"),
    "That sticker does not exist.",
  );
  assert.doesNotMatch(translateServerMessage("en", "CONFLICT", "未收录的中文错误"), /[\u3400-\u9fff]/);
});
