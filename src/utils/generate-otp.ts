import moment, { Moment } from "moment";

const generateOtp = (
  expiry: number = 10
): { otp: number; otpExpires: Moment } => {
  const otp = Math.floor(100000 + Math.random() * 900000);
  const otpExpires = moment().add(expiry, "minutes");

  return { otp, otpExpires };
};

export default generateOtp;
