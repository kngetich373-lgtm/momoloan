/**
 * Development OTP delivery writes to the server terminal only.
 * Before production, connect a legitimate SMS provider here.
 * Never return OTPs in API responses in production.
 */
async function sendOtp(phone, code) {
  console.log(`[DEV ONLY] SMS OTP for ${phone}: ${code}`);
}
module.exports = { sendOtp };
