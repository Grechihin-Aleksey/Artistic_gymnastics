import { Body, Controller, Get, Param, ParseUUIDPipe, Post } from "@nestjs/common";
import {
  createInquirySchema,
  resolveInquirySchema,
  type CreateInquiryInput,
  type ResolveInquiryInput,
} from "@ag/shared";
import { CurrentPrincipal, RequireAccess, type Principal } from "../auth/auth";
import { ZodPipe } from "../zod.pipe";
import { InquiriesService } from "./inquiries.service";

/** Запросы записывает и решения жюри вносит секретариат. */
@Controller()
@RequireAccess("admin")
export class InquiriesController {
  constructor(private readonly inquiries: InquiriesService) {}

  @Post("performances/:id/inquiries")
  create(
    @CurrentPrincipal() principal: Principal,
    @Param("id", ParseUUIDPipe) id: string,
    @Body(new ZodPipe(createInquirySchema)) body: CreateInquiryInput,
  ) {
    return this.inquiries.create(principal, id, body);
  }

  @Get("competitions/:id/inquiries")
  list(@Param("id", ParseUUIDPipe) id: string) {
    return this.inquiries.list(id);
  }

  @Post("inquiries/:id/resolve")
  resolve(
    @CurrentPrincipal() principal: Principal,
    @Param("id", ParseUUIDPipe) id: string,
    @Body(new ZodPipe(resolveInquirySchema)) body: ResolveInquiryInput,
  ) {
    return this.inquiries.resolve(principal, id, body);
  }
}
