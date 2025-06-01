import httpStatus from "http-status";
import catchAsync from "../utils/catch-async";
import pick from "../utils/pick";
import { Request, Response } from "express";
import { authService, userService, tokenService } from "../services";

const register = catchAsync(async (req: Request, res: Response) => {
  const user = await userService.createUser(req.body);

  res.status(httpStatus.CREATED).send({
    status: "success",
    message:
      "Your registration was successful. You may now log in to access the application.",
    data: {
      user: pick(user, ["id", "email", "firstName", "lastName"]),
    },
  });
});

const loginUserWithEmailAndPassword = catchAsync(
  async (req: Request, res: Response) => {
    const user = await authService.loginUserWithEmailAndPassword(
      req.body?.email || "",
      req.body?.password
    );

    const { token, expires } = await tokenService.generateAuthTokens(user.id);

    res.status(httpStatus.OK).send({
      status: "success",
      message: "Login successful. Welcome back!",
      data: {
        user: pick(user, ["id", "email", "firstName", "lastName"]),
        token,
        expires,
      },
    });
  }
);

export { register, loginUserWithEmailAndPassword };
