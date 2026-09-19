package com.openzeppelin.dex.iam;

import java.util.UUID;

public record Profile(UUID accountId, String displayName, Account.Role role, String partyId) {}
