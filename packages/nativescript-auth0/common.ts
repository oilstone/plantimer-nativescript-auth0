import { ApplicationSettings, Http, HttpResponse, isAndroid, Observable, Utils } from '@nativescript/core';
import { SecureStorage } from '@nativescript/secure-storage';
import { InAppBrowser } from 'nativescript-inappbrowser';
import { Subject } from 'rxjs';
import { AuthSessionResult } from 'nativescript-inappbrowser/InAppBrowser.common';
import { Auth0Error } from './auth0-error';
import { Config } from './index';
import { Base64 } from 'crypto-es/lib/enc-base64';
import { SHA256 } from 'crypto-es/lib/sha256';

export class Auth0Common extends Observable {
  private config: Config;
  protected verifier: string;
  accessToken$ = new Subject<string>();

  /**
   * Get a random string value
   *
   * @param size between 43 and 128 (default 128)
   */
  private static getRandomValues(size) {
    size = size >= 43 && size <= 128 ? size : 128;

    let benchStr = '';
    const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    for (let i = 0; i < size; i++) {
      benchStr += possible.charAt(Math.floor(Math.random() * possible.length));
    }

    return benchStr;
  }

  setTokens(json: { refresh_token: string; access_token: string }) {
    this.storeRefreshToken(json);
    this.storeAccessToken(json);
  }

  setUp(config: Config) {
    this.config = config;
    this.verifier = Auth0Common.getRandomValues(32);

    if (isAndroid) {
      InAppBrowser.mayLaunchUrl(this.prepareSignInAuthUrl(), []);
    }

    return this;
  }

  async loggedIn(): Promise<boolean> {
    if (ApplicationSettings.hasKey('@plantimer/auth0_user_logged_in')) {
      return ApplicationSettings.getBoolean('@plantimer/auth0_user_logged_in');
    }

    let isLoggedIn = false;

    try {
      const hasToken = await this.getAccessToken();

      isLoggedIn = !!hasToken;

      if (isLoggedIn) {
        ApplicationSettings.setBoolean('@plantimer/auth0_user_logged_in', true);
      }
    } catch (error) {
      // Treat this as not logged in
    }

    return isLoggedIn;
  }

  async signIn(loginHint: string | null = null, connection: string | null = null): Promise<boolean> {
    try {
      const code = await this.fetchCodeInAppBrowser(this.prepareSignInAuthUrl(loginHint, connection));

      if (!code) {
        return false;
      }

      await this.fetchRefreshToken(code, this.verifier);
    } catch (e) {
      this.clearStorage();

      throw new Auth0Error('Error during sign in', {
        additionalInfo: 'Every token has been deleted from the device.',
        error: e,
      });
    }

    return true;
  }

  async signUp(loginHint: string | null = null): Promise<boolean> {
    const code = await this.fetchCodeInAppBrowser(this.prepareSignUpAuthUrl(loginHint));

    if (!code) {
      return false;
    }

    await this.fetchRefreshToken(code, this.verifier);

    return true;
  }

  async logOut(): Promise<boolean> {
    const returnTo = this.config.auth0Config.redirectUri;
    const logout = this.prepareLogOutAuthUrl();

    try {
      if (await InAppBrowser.isAvailable()) {
        const response = await InAppBrowser.openAuth(logout, returnTo, this.config.browserConfig);
        if (response.type === 'cancel') {
          return false;
        }
      } else {
        Utils.openUrl(logout);
      }

      this.clearStorage();

      return true;
    } catch (e) {
      throw new Auth0Error('Something happened while logging out', {
        logout,
        returnTo,
        error: e,
      });
    }
  }

  async getUserInfo(force = false): Promise<object | null> {
    if (ApplicationSettings.hasKey('@plantimer/auth0_user_info') && !force) {
      return JSON.parse(ApplicationSettings.getString('@plantimer/auth0_user_info'));
    }

    const url = 'https://' + this.config.auth0Config.domain + '/userinfo';
    const response: HttpResponse = await Http.request({
      url,
      method: 'GET',
      headers: {
        'content-type': 'application/json',
        Authorization: 'Bearer ' + (await this.getAccessToken()),
      },
    });

    if (response.statusCode !== 200) {
      throw new Auth0Error("Failed to get the user's info", {
        url,
        httpResponseStatusCode: response.statusCode,
        httpResponseBody: response.content,
      });
    }

    const userInfo = response?.content?.toJSON();

    ApplicationSettings.setString('@plantimer/auth0_user_info', JSON.stringify(userInfo));

    return userInfo;
  }

  /**
   * Get or fetch an access token based on the refresh token
   */
  async getAccessToken(force = false): Promise<string | null> {
    const secureStorage = new SecureStorage();

    if (force) {
      secureStorage.removeSync({ key: '@plantimer/auth0_access_token' });
    }

    const tokenExpire = ApplicationSettings.getNumber('@plantimer/auth0_access_token_expire');
    const storedToken = secureStorage.getSync({ key: '@plantimer/auth0_access_token' });
    if (storedToken && tokenExpire && Date.now() <= tokenExpire) {
      return storedToken;
    }

    const accessToken = await this.fetchAccessToken();
    this.accessToken$.next(accessToken);

    return accessToken;
  }

  private async fetchAccessToken(): Promise<string | null> {
    const secureStorage = new SecureStorage();
    const refreshToken = secureStorage.getSync({ key: '@plantimer/auth0_refresh_token' });
    if (!refreshToken) {
      return null;
    }

    try {
      const response: HttpResponse = await Http.request({
        url: 'https://' + this.config.auth0Config.domain + '/oauth/token',
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        content: JSON.stringify({
          grant_type: 'refresh_token',
          client_id: this.config.auth0Config.clientId,
          refresh_token: refreshToken,
        }),
      });
      const json = response.content.toJSON();

      await Promise.all([this.storeRefreshToken(json), this.storeAccessToken(json)]);

      return json.access_token;
    } catch (e) {
      throw new Auth0Error('Issue when fetching an access token using a refresh token', { error: e });
    }

    return null;
  }

  protected async fetchRefreshToken(code: string, verifier: string): Promise<void> {
    if (!code || !verifier) {
      throw new Auth0Error('Missing code or verifier', {});
    }

    const refresh_token_response: HttpResponse = await Http.request({
      url: 'https://' + this.config.auth0Config.domain + '/oauth/token',
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      content: JSON.stringify({
        grant_type: 'authorization_code',
        client_id: this.config.auth0Config.clientId,
        code: code,
        code_verifier: verifier,
        audience: this.config.auth0Config.audience,
        redirect_uri: this.config.auth0Config.redirectUri,
      }),
    });

    const json = refresh_token_response.content.toJSON();
    this.storeRefreshToken(json);
    this.storeAccessToken(json);
  }

  private storeAccessToken(json): string | null {
    const accessToken = json?.access_token;
    if (!accessToken) {
      return null;
    }

    const expireSeconds = json.expires_in;

    const secureStorage = new SecureStorage();
    secureStorage.setSync({ key: '@plantimer/auth0_access_token', value: accessToken });

    const expireDate = new Date();
    expireDate.setSeconds(expireDate.getSeconds() + expireSeconds);
    ApplicationSettings.setNumber('@plantimer/auth0_access_token_expire', expireDate.getTime());

    return accessToken;
  }

  private storeRefreshToken(json): string {
    const refreshToken = json.refresh_token;
    if (!refreshToken) {
      return;
    }

    const secureStorage = new SecureStorage();
    secureStorage.setSync({ key: '@plantimer/auth0_refresh_token', value: refreshToken });

    return refreshToken;
  }

  private prepareSignUpAuthUrl(loginHint: string | null = null): string {
    return this.prepareSignInAuthUrl(loginHint, null, 'signup');
  }

  private prepareSignInAuthUrl(loginHint: string | null = null, connection: string | null = null, screenHint: string | null = null): string {
    const challenge: string = Base64.stringify(SHA256(this.verifier)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');

    const params: Record<string, any> = {
      audience: this.config.auth0Config.audience,
      scope: this.config.auth0Config.scope || 'offline_access openid profile email',
      response_type: 'code',
      client_id: this.config.auth0Config.clientId,
      redirect_uri: this.config.auth0Config.redirectUri,
      code_challenge: challenge,
      code_challenge_method: 'S256',
      login_hint: loginHint || null,
      connection: connection || null,
      screen_hint: screenHint || null,
    };

    if (!params.audience || !params.client_id || !params.redirect_uri) {
      console.error('Auth0 configuration is missing required fields (audience, client_id, redirect_uri)', this.config.auth0Config);

      throw new Error('Auth0 configuration is missing required fields.');
    }

    return `https://${this.config.auth0Config.domain}/authorize${this.objectToQueryParams(params)}`;
  }

  private prepareLogOutAuthUrl(): string {
    const params = {
      client_id: this.config.auth0Config.clientId,
      returnTo: this.config.auth0Config.redirectUri,
    };

    if (!params.client_id || !params.returnTo) {
      console.error('Auth0 configuration is missing required fields (client_id, returnTo)', this.config.auth0Config);

      throw new Error('Auth0 configuration is missing required fields.');
    }

    return `https://${this.config.auth0Config.domain}/v2/logout${this.objectToQueryParams(params)}`;
  }

  private async fetchCodeInAppBrowser(authorizeUrl: string): Promise<string | false> {
    let response: AuthSessionResult = await InAppBrowser.openAuth(authorizeUrl, this.config.auth0Config.redirectUri);

    // Check if the response is a request to restart the authentication flow as a passwordless sign in
    // WARNING - oilstone specific. Do not merge into non-main branches
    if (response.type === 'success' && response.url?.includes('/passwordless')) {
      const urlObj = new URL(response.url);
      const params = new URLSearchParams(urlObj.search);
      const loginHint = params.get('login_hint');

      response = await InAppBrowser.openAuth(this.prepareSignInAuthUrl(loginHint, 'email'), this.config.auth0Config.redirectUri);
    }

    if (response.type === 'success' && response.url) {
      // Split the string to obtain the code or the access token
      return response.url.split('=')[1];
    }

    return false;
  }

  private clearStorage() {
    const secureStorage = new SecureStorage();
    secureStorage.removeSync({ key: '@plantimer/auth0_refresh_token' });
    secureStorage.removeSync({ key: '@plantimer/auth0_access_token' });
    ApplicationSettings.remove('@plantimer/auth0_access_token_expire');
    ApplicationSettings.remove('@plantimer/auth0_user_info');
    ApplicationSettings.remove('@plantimer/auth0_user_logged_in');
    this.accessToken$.next('');
  }

  private objectToQueryParams(params: Record<string, any>): string {
    // Filter out null and undefined values
    const validParams = Object.entries(params).filter(([_, value]) => value !== null && value !== undefined);

    if (validParams.length === 0) {
      return '';
    }

    const queryString = validParams
      .map(([key, value]) => {
        // Handle different types of values
        if (Array.isArray(value)) {
          // For arrays, use the same key multiple times
          return value.map((item) => `${encodeURIComponent(key)}=${encodeURIComponent(String(item))}`).join('&');
        } else if (typeof value === 'object') {
          // For objects, stringify them
          return `${encodeURIComponent(key)}=${encodeURIComponent(JSON.stringify(value))}`;
        } else {
          // For primitive values
          return `${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`;
        }
      })
      .join('&');

    return `?${queryString}`;
  }
}
