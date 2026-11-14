/**
 * MTN Authentication Provider.
 * 
 * IMPORTANT: This is a simulation for testing purposes.
 * For production, this should integrate with the authorized MTN authentication API.
 */

async function verifyOtp(phone, otp) {
  // Simulate network latency
  await new Promise(r => setTimeout(r, 500));
  
  // In development, accept any 6-digit code
  if (process.env.NODE_ENV !== "production") {
    return { success: true };
  }

  // In a real scenario, this would call the MTN API.
  // For now, we simulate success/failure.
  if (otp === "123456") return { success: true };
  if (otp === "000000") return { success: false, reason: "expired" };
  return { success: false, reason: "invalid" };
}

async function verifyPin(phone, pin) {
  // Simulate network latency
  await new Promise(r => setTimeout(r, 500));
  
  // In a real scenario, this would call the MTN API.
  if (pin === "1234") return { success: true };
  return { success: false, reason: "invalid" };
}

module.exports = { verifyOtp, verifyPin };
