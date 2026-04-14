import { ACCESS_TOKEN_MAX_AGE_MS, REFRESH_TOKEN_MAX_AGE_MS } from "./tokenGenerate.js";

// Authentication helper functions

const isCrossSiteRequest = (req) => {
  const origin = req?.headers?.origin;
  const host = req?.get?.("host");

  if (!origin || !host) {
    const frontendUrl = process.env.FRONTEND_URL || "";
    return frontendUrl.startsWith("https://") && !frontendUrl.includes("localhost");
  }

  try {
    const originUrl = new URL(origin);
    const requestProtocol = req.headers["x-forwarded-proto"] || req.protocol || "http";
    const requestUrl = new URL(`${requestProtocol}://${host}`);

    const sameHostname = originUrl.hostname === requestUrl.hostname;
    const bothLocalhost =
      (originUrl.hostname === "localhost" || originUrl.hostname === "127.0.0.1") &&
      (requestUrl.hostname === "localhost" || requestUrl.hostname === "127.0.0.1");

    return !(sameHostname || bothLocalhost);
  } catch {
    return false;
  }
};

export const getAuthCookieOptions = (req) => {
  const useCrossSiteCookies = isCrossSiteRequest(req);

  return {
    httpOnly: true,
    secure: useCrossSiteCookies,
    sameSite: useCrossSiteCookies ? "None" : "Lax",
    path: "/",
  };
};

/**
 * Sets access and refresh tokens in HTTP-only cookies
 * @param {Object} res - Express response object
 * @param {string} accessToken - JWT access token
 * @param {string} refreshToken - JWT refresh token
 */
export const setAuthCookies = (res, accessToken, refreshToken, req) => {
  const cookieOptions = getAuthCookieOptions(req);

  res.cookie("accessToken", accessToken, {
    ...cookieOptions,
    maxAge: ACCESS_TOKEN_MAX_AGE_MS,
  });

  res.cookie("refreshToken", refreshToken, {
    ...cookieOptions,
    maxAge: REFRESH_TOKEN_MAX_AGE_MS,
  });
};

/**
 * Clears authentication cookies
 * @param {Object} res - Express response object
 */
export const clearAuthCookies = (res, req) => {
  const cookieOptions = getAuthCookieOptions(req);

  res.clearCookie("accessToken", {
    ...cookieOptions
  });

  res.clearCookie("refreshToken", {
    ...cookieOptions
  });
};

/**
 * Formats user object for response (excludes sensitive data)
 * @param {Object} user - User document
 * @returns {Object} - Formatted user object
 */
export const formatUserResponse = (user) => {
  return {
    id: user._id,
    firstname: user.firstname,
    lastname: user.lastname,
    phone: user.phone,
    country_code: user.country_code,
    is_verified: user.is_verified,
    isAdmin: user.isAdmin,
    isSubAdmin: user.isSubAdmin,
    isCoordinator: user.isCoordinator,
    isSuperAdmin: user.isSuperAdmin,
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
    subscription: user.subscription,
    primary_account_id: user.primary_account_id,
    isFirstLogin: user.isFirstLogin,
    ...(user.status && { status: user.status })
  };
};

/**
 * Checks if user is verified and active
 * @param {Object} user - User document
 * @returns {Object|null} - Error response object if invalid, null if valid
 */
export const validateUserStatus = (user) => {
  if (!user.is_verified) {
    return {
      status: 403,
      message: "Please verify your phone number first"
    };
  }

  if (user.status !== 'active') {
    return {
      status: 403,
      message: "Your account is inactive. Please contact support."
    };
  }

  return null;
};

/**
 * Validates OTP (checks existence and expiration)
 * @param {Object} user - User document with OTP fields
 * @param {string} otp - OTP to verify
 * @returns {Object|null} - Error response object if invalid, null if valid
 */
export const validateOtp = async (user, otp) => {
  if (!user.otp) {
    return {
      status: 400,
      message: "OTP not found. Please request a new OTP"
    };
  }

  if (new Date() > user.otpExpires) {
    // Clear expired OTP
    user.otp = undefined;
    user.otpExpires = undefined;
    await user.save();

    return {
      status: 400,
      message: "OTP has expired. Please request a new OTP"
    };
  }

  if (user.otp !== otp) {
    return {
      status: 400,
      message: "Invalid OTP"
    };
  }

  return null;
};

