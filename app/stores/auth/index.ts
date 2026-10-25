import { defineStore } from "pinia";
import { useLocalStorage } from "@vueuse/core";
import { FetchError } from "ofetch";
import { recordFromUnknown } from "~~/shared/utils/records";

export const AUTH_STORAGE_KEY = "codex-gateway-auth-token";

export const useAuthStore = defineStore("auth", () => {
  const token = ref("");
  const username = ref("");
  const initialized = ref(false);
  const sessionEpoch = ref(0);
  const tailscaleAccess = ref(false);
  const resolvingTrustedSession = ref(false);
  let trustedLogin: Promise<void> | null = null;
  const storedToken = useLocalStorage<string | null>(AUTH_STORAGE_KEY, null);
  const storedUsername = useLocalStorage<string | null>(`${AUTH_STORAGE_KEY}:username`, null);

  const isAuthenticated = computed(() => token.value !== "");

  watch([storedToken, storedUsername], ([nextToken, nextUsername]) => {
    if (!initialized.value) return;
    // VueUse synchronizes useLocalStorage across same-origin tabs. Mirror that durable state into
    // the live session so logout/account switches advance sessionEpoch and cancel stale HTTP/RAF
    // work in every open Gateway tab without waiting for a refresh.
    replaceSession(nextToken ?? "", nextUsername ?? "");
    if ((nextToken ?? "") === "" && tailscaleAccess.value) void loginWithTailscale();
  });

  function hydrate() {
    if (!import.meta.client || initialized.value) {
      return;
    }
    replaceSession(storedToken.value ?? "", storedUsername.value ?? "");
    initialized.value = true;
    void loginWithTailscale();
  }

  function loginWithTailscale(): Promise<void> {
    if (trustedLogin) return trustedLogin;
    const epoch = sessionEpoch.value;
    let staleSuccessfulBootstrap = false;
    resolvingTrustedSession.value = true;
    trustedLogin = $fetch<{ token: string; user: { username: string } }>("/api/auth/tailscale", {
      method: "POST",
      body: {},
      headers: token.value ? { authorization: `Bearer ${token.value}` } : {},
      retry: 0,
      timeout: 5000,
    })
      .then((session) => {
        tailscaleAccess.value = true;
        if (epoch === sessionEpoch.value) {
          setSession(session.token, session.user.username);
        } else if (token.value === "") {
          staleSuccessfulBootstrap = true;
        }
      })
      .catch((error: unknown) => {
        const payload: unknown = error instanceof FetchError ? error.data : undefined;
        if (recordFromUnknown(recordFromUnknown(payload)?.data)?.authMode === "tailscale") {
          tailscaleAccess.value = true;
        }
      })
      .finally(() => {
        resolvingTrustedSession.value = false;
        trustedLogin = null;
        // A cross-tab clear can invalidate a successful in-flight bootstrap. Retry only that
        // stale success, never denied/network failures, after releasing the single-flight latch.
        if (staleSuccessfulBootstrap && token.value === "") void loginWithTailscale();
      });
    return trustedLogin;
  }

  async function login(input: { username: string; password: string }) {
    const session = await $fetch<{
      token: string;
      expiresAt: string;
      user: { id: number; username: string };
    }>("/api/auth/login", {
      method: "POST",
      body: input,
    });
    setSession(session.token, session.user.username);
    return session;
  }

  function setSession(nextToken: string, nextUsername: string) {
    replaceSession(nextToken, nextUsername);
    initialized.value = true;
    storedToken.value = nextToken;
    storedUsername.value = nextUsername;
  }

  async function logout() {
    const currentToken = token.value;
    if (currentToken !== "") {
      try {
        await $fetch("/api/auth/logout", {
          method: "POST",
          headers: { authorization: `Bearer ${currentToken}` },
        });
      } finally {
        clearSession();
      }
      return;
    }
    clearSession();
  }

  function clearSession() {
    replaceSession("", "");
    initialized.value = true;
    storedToken.value = null;
    storedUsername.value = null;
    if (tailscaleAccess.value) void loginWithTailscale();
  }

  function replaceSession(nextToken: string, nextUsername: string) {
    if (token.value !== nextToken) sessionEpoch.value += 1;
    token.value = nextToken;
    username.value = nextUsername;
  }

  function isCurrentSession(epoch: number) {
    return sessionEpoch.value === epoch;
  }

  return {
    token,
    username,
    initialized,
    sessionEpoch,
    isAuthenticated,
    tailscaleAccess,
    resolvingTrustedSession,
    loginWithTailscale,
    hydrate,
    login,
    logout,
    clearSession,
    isCurrentSession,
  };
});
