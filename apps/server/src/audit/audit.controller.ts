import { Controller, Get, Param, ParseUUIDPipe, Query } from "@nestjs/common";
import { AUDIT_GROUPS, type AuditGroup } from "@ag/shared";
import { z } from "zod";
import { RequireAccess } from "../auth/auth";
import { ZodPipe } from "../zod.pipe";
import { AuditService } from "./audit.service";

export const auditGroupQuery = new ZodPipe(z.enum(AUDIT_GROUPS).optional());

/** Журнал изменений видит только секретариат: в нём действия судей и решения по запросам. */
@Controller("competitions/:id/audit")
export class AuditController {
  constructor(private readonly audit: AuditService) {}

  @Get()
  @RequireAccess("admin")
  list(@Param("id", ParseUUIDPipe) id: string, @Query("group", auditGroupQuery) group: AuditGroup | undefined) {
    return this.audit.list(id, group);
  }
}
