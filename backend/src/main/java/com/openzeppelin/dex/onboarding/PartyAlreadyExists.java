package com.openzeppelin.dex.onboarding;

/** A definitive registration conflict, not an uncertain submission to reconcile. */
public final class PartyAlreadyExists extends OnboardingConflict {
  public PartyAlreadyExists() {
    super("This party already exists. Registration was stopped.");
  }
}
