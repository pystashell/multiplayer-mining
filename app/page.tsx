import { cookies, headers } from "next/headers";
import { MinefieldApp } from "./MinefieldApp";
import { LOCALE_COOKIE, localeFromLanguage, parseLocale } from "./i18n";

export default async function Home() {
  const cookieStore = await cookies();
  const requestHeaders = await headers();
  const initialLocale = parseLocale(cookieStore.get(LOCALE_COOKIE)?.value)
    ?? localeFromLanguage(requestHeaders.get("accept-language"));
  return <MinefieldApp initialLocale={initialLocale} />;
}
